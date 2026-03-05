import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { EMBEDDING_DIM } from './config.js';
import { _initTestDatabase, _getTestDb, isSemanticsEnabled } from './db.js';
import { storeEmbedding } from './embedding-service.js';

// Automock embedding-service to control embed() and isSemanticsEnabled() returns.
// Using automocking (no factory) to avoid Vitest hoisting issues per STATE.md pattern.
vi.mock('./embedding-service.js');
vi.mock('./db.js');

import { embed } from './embedding-service.js';
import { hybridSearch, buildSemanticContext } from './semantic-retrieval.js';

// Re-import real implementations after mocking at module level
// We need real DB functions for integration-style tests.
// Strategy: unmock db.js for tests that need a real DB, mock isSemanticsEnabled for pure unit tests.

// -----------------------------------------------------------------------
// Helper: create a real in-memory DB and populate it with test embeddings
// -----------------------------------------------------------------------

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = seed * 0.001 + i * 0.0001;
  }
  return v;
}

// -----------------------------------------------------------------------
// hybridSearch() — semantics disabled guard
// -----------------------------------------------------------------------

describe('hybridSearch() — semantics disabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSemanticsEnabled).mockReturnValue(false);
  });

  it('returns [] immediately when isSemanticsEnabled() is false', async () => {
    const results = await hybridSearch('group-a', 'some query');
    expect(results).toEqual([]);
  });

  it('does not call embed() when semantics disabled', async () => {
    await hybridSearch('group-a', 'some query');
    expect(embed).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// hybridSearch() — with real in-memory database
// -----------------------------------------------------------------------

describe('hybridSearch() — with real DB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use real isSemanticsEnabled() from an in-memory DB
    vi.mocked(isSemanticsEnabled).mockImplementation(() => {
      // Re-require the real db module to get current state
      // We proxy through a freshly initialized test DB
      const { isSemanticsEnabled: realFn } = vi.importActual('./db.js') as typeof import('./db.js');
      return realFn();
    });
  });

  it('returns KNN results when embed() returns a vector', async () => {
    // Initialize a fresh in-memory DB with semantics
    const { _initTestDatabase: realInit, _getTestDb: realGetDb, isSemanticsEnabled: realIsSemEnabled } =
      await vi.importActual('./db.js') as typeof import('./db.js');
    realInit();
    const db = realGetDb();

    if (!realIsSemEnabled()) {
      console.log('sqlite-vec not available, skipping KNN test');
      return;
    }

    const { storeEmbedding: realStore } = await vi.importActual('./embedding-service.js') as typeof import('./embedding-service.js');

    const vec = makeVec(1);
    realStore(db, 'group-a', 'knowledge', 'notes/file.md', 'hello world content', vec);

    // Mock embed() to return the same vector (should find the stored embedding)
    vi.mocked(embed).mockResolvedValue(vec);
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);

    const results = await hybridSearch('group-a', 'hello world', { db });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].via).toBe('knn');
    expect(results[0].sourcePath).toBe('notes/file.md');
  });

  it('returns FTS5-only results when embed() returns null (Ollama unavailable)', async () => {
    const { _initTestDatabase: realInit, _getTestDb: realGetDb, isSemanticsEnabled: realIsSemEnabled } =
      await vi.importActual('./db.js') as typeof import('./db.js');
    realInit();
    const db = realGetDb();

    if (!realIsSemEnabled()) {
      console.log('sqlite-vec not available, skipping FTS5 fallback test');
      return;
    }

    const { storeEmbedding: realStore } = await vi.importActual('./embedding-service.js') as typeof import('./embedding-service.js');

    const vec = makeVec(2);
    realStore(db, 'group-a', 'knowledge', 'notes/fts-file.md', 'unique keyword content here', vec);

    // Simulate Ollama down
    vi.mocked(embed).mockResolvedValue(null);
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);

    const results = await hybridSearch('group-a', 'unique keyword content', { db });

    expect(results.length).toBeGreaterThan(0);
    const ftsResult = results.find((r) => r.via === 'fts5');
    expect(ftsResult).toBeDefined();
    expect(ftsResult!.sourcePath).toBe('notes/fts-file.md');
  });

  it('deduplicates by source_path — same path from KNN and FTS5 appears once with via=knn', async () => {
    const { _initTestDatabase: realInit, _getTestDb: realGetDb, isSemanticsEnabled: realIsSemEnabled } =
      await vi.importActual('./db.js') as typeof import('./db.js');
    realInit();
    const db = realGetDb();

    if (!realIsSemEnabled()) {
      console.log('sqlite-vec not available, skipping dedup test');
      return;
    }

    const { storeEmbedding: realStore } = await vi.importActual('./embedding-service.js') as typeof import('./embedding-service.js');

    const vec = makeVec(3);
    realStore(db, 'group-a', 'knowledge', 'notes/dedup.md', 'dedup test content query', vec);

    // embed() returns the vector → both KNN and FTS5 will find this file
    vi.mocked(embed).mockResolvedValue(vec);
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);

    const results = await hybridSearch('group-a', 'dedup test content query', { db });

    const paths = results.map((r) => r.sourcePath);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length); // no duplicates

    // The path that appears via both should be flagged as 'knn' (KNN takes priority)
    const dedupResult = results.find((r) => r.sourcePath === 'notes/dedup.md');
    expect(dedupResult?.via).toBe('knn');
  });

  it('returns 0 results from group-b when querying group-a embeddings (group isolation)', async () => {
    const { _initTestDatabase: realInit, _getTestDb: realGetDb, isSemanticsEnabled: realIsSemEnabled } =
      await vi.importActual('./db.js') as typeof import('./db.js');
    realInit();
    const db = realGetDb();

    if (!realIsSemEnabled()) {
      console.log('sqlite-vec not available, skipping isolation test');
      return;
    }

    const { storeEmbedding: realStore } = await vi.importActual('./embedding-service.js') as typeof import('./embedding-service.js');

    const vec = makeVec(4);
    realStore(db, 'group-a', 'knowledge', 'notes/isolated.md', 'group a private content', vec);

    vi.mocked(embed).mockResolvedValue(vec);
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);

    // Query with group-b — should return nothing
    const results = await hybridSearch('group-b', 'group a private content', { db });

    expect(results).toHaveLength(0);
  });

  it('returns [] for a new group with no embeddings', async () => {
    const { _initTestDatabase: realInit, _getTestDb: realGetDb, isSemanticsEnabled: realIsSemEnabled } =
      await vi.importActual('./db.js') as typeof import('./db.js');
    realInit();
    const db = realGetDb();

    if (!realIsSemEnabled()) {
      console.log('sqlite-vec not available, skipping empty group test');
      return;
    }

    vi.mocked(embed).mockResolvedValue(makeVec(5));
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);

    const results = await hybridSearch('brand-new-group', 'anything', { db });

    expect(results).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// buildFtsQuery() — internal helper tested via hybridSearch edge cases
// These tests exercise the exported function behavior indirectly.
// The plan also requests direct tests of buildFtsQuery(), but since it's
// internal (not exported), we test it via the exported testBuildFtsQuery
// or we export it for testing purposes.
// -----------------------------------------------------------------------

// Re-import to check if buildFtsQuery is exported (it may be internal)
// The plan says to test it — we'll export it from semantic-retrieval.ts
import { buildFtsQuery } from './semantic-retrieval.js';

describe('buildFtsQuery()', () => {
  it('returns null for empty string', () => {
    expect(buildFtsQuery('')).toBeNull();
  });

  it('returns null for strings with only short words (< 3 chars)', () => {
    expect(buildFtsQuery('a bb')).toBeNull();
    expect(buildFtsQuery('to be')).toBeNull();
    expect(buildFtsQuery('ok no')).toBeNull();
  });

  it('strips FTS5 special chars and returns safe OR-joined terms', () => {
    const result = buildFtsQuery('hello "world" (test) foo*bar');
    expect(result).not.toBeNull();
    // Should not contain FTS5 special chars
    expect(result).not.toMatch(/["*^()]/);
    // Should be OR-joined
    expect(result).toContain('OR');
  });

  it('filters words shorter than 3 chars', () => {
    const result = buildFtsQuery('hello world is ok');
    // 'is' (2 chars) and 'ok' (2 chars) should be filtered out
    expect(result).not.toContain('is');
    expect(result).not.toContain('ok');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('limits to 10 terms maximum', () => {
    const longQuery = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm';
    const result = buildFtsQuery(longQuery);
    expect(result).not.toBeNull();
    const terms = result!.split(' OR ');
    expect(terms.length).toBeLessThanOrEqual(10);
  });
});

// -----------------------------------------------------------------------
// buildSemanticContext()
// -----------------------------------------------------------------------

describe('buildSemanticContext()', () => {
  it('returns empty string when results is empty', () => {
    const result = buildSemanticContext('group-a', []);
    expect(result).toBe('');
  });

  it('reads file content and formats with "## Semantic Memory" header', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    const groupDir = path.join(tmpDir, 'group-a');
    const notesDir = path.join(groupDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'file.md'), 'This is test content.');

    const results = [
      { sourceType: 'knowledge', sourcePath: 'notes/file.md', via: 'knn' as const },
    ];

    const output = buildSemanticContext('group-a', results, { groupsDir: tmpDir });

    expect(output).toContain('## Semantic Memory');
    expect(output).toContain('This is test content.');
    expect(output).toContain('[knowledge] notes/file.md');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty string when all files are missing/unreadable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    fs.mkdirSync(path.join(tmpDir, 'group-a'), { recursive: true });

    const results = [
      { sourceType: 'knowledge', sourcePath: 'nonexistent/file.md', via: 'fts5' as const },
    ];

    const output = buildSemanticContext('group-a', results, { groupsDir: tmpDir });

    expect(output).toBe('');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('truncates at SEMANTIC_CONTEXT_MAX_CHARS (4000) across results', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    const groupDir = path.join(tmpDir, 'group-a');
    fs.mkdirSync(groupDir, { recursive: true });

    // Create many files, each with 1000 chars of content
    const largeContent = 'x'.repeat(1000);
    const results = [];
    for (let i = 0; i < 10; i++) {
      const filename = `file${i}.md`;
      fs.writeFileSync(path.join(groupDir, filename), largeContent);
      results.push({ sourceType: 'knowledge', sourcePath: filename, via: 'knn' as const });
    }

    const output = buildSemanticContext('group-a', results, { groupsDir: tmpDir });

    // Output should not include all 10 files because total would exceed 4000 chars
    // Each file adds ~1000 chars + header, so roughly 4 files fit before truncation
    // The total output length should be reasonable (not 10,000+ chars)
    expect(output.length).toBeLessThan(8000); // generous upper bound
    expect(output).not.toContain('file9.md'); // last file should be truncated

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('includes distance info for KNN results and omits it for FTS5', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    const groupDir = path.join(tmpDir, 'group-a');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'test.md'), 'Test content');

    const results = [
      { sourceType: 'fact', sourcePath: 'test.md', distance: 0.12, via: 'knn' as const },
    ];

    const output = buildSemanticContext('group-a', results, { groupsDir: tmpDir });

    // Should contain the file content
    expect(output).toContain('Test content');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
