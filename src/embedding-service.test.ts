import { describe, it, expect, vi, beforeEach } from 'vitest';

import { EMBEDDING_DIM } from './config.js';
import { _initTestDatabase, _getTestDb, isSemanticsEnabled } from './db.js';
import {
  embed,
  batchEmbed,
  contentHash,
  storeEmbedding,
  deleteEmbedding,
  checkOllamaReachability,
  _resetClient,
} from './embedding-service.js';

// Use Vitest automocking so the Ollama constructor and its methods are replaced
// with vi.fn() stubs. This avoids hoisting issues caused by factory-based mocks
// when the test file also imports modules that transitively import 'ollama'.
vi.mock('ollama');

import { Ollama } from 'ollama';

// Build a fake EMBEDDING_DIM-float Ollama embed response
function fakeEmbeddingResponse(count = 1): { embeddings: number[][] } {
  const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
  return { embeddings: Array.from({ length: count }, () => [...vec]) };
}

beforeEach(() => {
  _resetClient();
  vi.clearAllMocks();
});

// --- embed() ---

describe('embed()', () => {
  it('returns Float32Array of length EMBEDDING_DIM on success', async () => {
    vi.mocked(Ollama.prototype.embed).mockResolvedValue(
      fakeEmbeddingResponse(1) as never,
    );

    const result = await embed('hello');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result!.length).toBe(EMBEDDING_DIM);
  });

  it('returns null when Ollama client throws (connection refused)', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await embed('hello');

    expect(result).toBeNull();
  });

  it('never throws even on unexpected errors', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new TypeError('unexpected'));

    await expect(embed('hello')).resolves.toBeNull();
  });
});

// --- batchEmbed() ---

describe('batchEmbed()', () => {
  it('returns Float32Array[] of correct length on success', async () => {
    vi.mocked(Ollama.prototype.embed).mockResolvedValue(
      fakeEmbeddingResponse(2) as never,
    );

    const result = await batchEmbed(['a', 'b']);

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(2);
    expect(result![0]).toBeInstanceOf(Float32Array);
    expect(result![0].length).toBe(EMBEDDING_DIM);
    expect(result![1]).toBeInstanceOf(Float32Array);
    expect(result![1].length).toBe(EMBEDDING_DIM);
  });

  it('returns null when Ollama client throws', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await batchEmbed(['a', 'b']);

    expect(result).toBeNull();
  });

  it('never throws even on unexpected errors', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new TypeError('unexpected'));

    await expect(batchEmbed(['x'])).resolves.toBeNull();
  });
});

// --- contentHash() ---

describe('contentHash()', () => {
  it('returns a consistent SHA-256 hex string', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('hello');
    expect(hash1).toBe(hash2);
    // SHA-256 hex is 64 chars
    expect(hash1).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
  });

  it('different input produces different hash (no normalization)', () => {
    const h1 = contentHash('hello');
    const h2 = contentHash('hello ');
    expect(h1).not.toBe(h2);
  });

  it('known SHA-256 value for "hello"', () => {
    // SHA-256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

// --- storeEmbedding() ---

describe('storeEmbedding()', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('inserts into vec_embeddings and embedding_meta', () => {
    if (!isSemanticsEnabled()) {
      console.log('sqlite-vec not available, skipping storeEmbedding tests');
      return;
    }

    const db = _getTestDb();
    const vec = new Float32Array(EMBEDDING_DIM).fill(0.1);

    storeEmbedding(db, 'group1', 'knowledge', '/path/file.md', 'hello world', vec);

    const meta = db
      .prepare('SELECT * FROM embedding_meta WHERE group_folder = ?')
      .all('group1') as Array<{ id: number; vec_rowid: number; content_hash: string }>;
    expect(meta).toHaveLength(1);
    expect(meta[0].content_hash).toBe(contentHash('hello world'));

    const embRow = db
      .prepare('SELECT rowid FROM vec_embeddings WHERE rowid = ?')
      .get(meta[0].vec_rowid);
    expect(embRow).toBeDefined();
  });

  it('skips insertion when content_hash is unchanged (same content)', () => {
    if (!isSemanticsEnabled()) return;

    const db = _getTestDb();
    const vec = new Float32Array(EMBEDDING_DIM).fill(0.1);

    storeEmbedding(db, 'group1', 'knowledge', '/path/file.md', 'same text', vec);
    storeEmbedding(db, 'group1', 'knowledge', '/path/file.md', 'same text', vec);

    const meta = db
      .prepare('SELECT * FROM embedding_meta WHERE group_folder = ?')
      .all('group1');
    // Only one row — second call was a no-op
    expect(meta).toHaveLength(1);
  });

  it('replaces old embedding when content changes (different hash, same path)', () => {
    if (!isSemanticsEnabled()) return;

    const db = _getTestDb();
    const vec1 = new Float32Array(EMBEDDING_DIM).fill(0.1);
    const vec2 = new Float32Array(EMBEDDING_DIM).fill(0.9);

    storeEmbedding(db, 'group1', 'knowledge', '/path/file.md', 'original text', vec1);
    const firstMeta = db
      .prepare('SELECT vec_rowid FROM embedding_meta WHERE group_folder = ?')
      .get('group1') as { vec_rowid: number };
    const firstRowId = firstMeta.vec_rowid;

    storeEmbedding(db, 'group1', 'knowledge', '/path/file.md', 'updated text', vec2);

    const allMeta = db
      .prepare('SELECT * FROM embedding_meta WHERE group_folder = ?')
      .all('group1') as Array<{ content_hash: string; vec_rowid: number }>;
    expect(allMeta).toHaveLength(1);
    expect(allMeta[0].content_hash).toBe(contentHash('updated text'));
    // Old rowid should be gone from vec_embeddings
    const oldVec = db
      .prepare('SELECT rowid FROM vec_embeddings WHERE rowid = ?')
      .get(firstRowId);
    expect(oldVec).toBeUndefined();
  });
});

// --- deleteEmbedding() ---

describe('deleteEmbedding()', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('removes both embedding_meta and vec_embeddings rows after a store', () => {
    if (!isSemanticsEnabled()) {
      console.log('sqlite-vec not available, skipping deleteEmbedding tests');
      return;
    }

    const db = _getTestDb();
    const vec = new Float32Array(EMBEDDING_DIM).fill(0.2);

    storeEmbedding(db, 'group1', 'fact', 'knowledge/pref.md', 'some fact', vec);

    const beforeMeta = db
      .prepare('SELECT * FROM embedding_meta WHERE group_folder = ?')
      .all('group1');
    expect(beforeMeta).toHaveLength(1);

    deleteEmbedding(db, 'group1', 'fact', 'knowledge/pref.md');

    const afterMeta = db
      .prepare('SELECT * FROM embedding_meta WHERE group_folder = ?')
      .all('group1');
    expect(afterMeta).toHaveLength(0);

    const afterVec = db
      .prepare('SELECT rowid FROM vec_embeddings')
      .all();
    expect(afterVec).toHaveLength(0);
  });

  it('does not throw when the key does not exist (no-op)', () => {
    if (!isSemanticsEnabled()) return;

    const db = _getTestDb();

    expect(() =>
      deleteEmbedding(db, 'nonexistent', 'fact', 'knowledge/missing.md'),
    ).not.toThrow();
  });
});

// --- checkOllamaReachability() ---

describe('checkOllamaReachability()', () => {
  it('logs warning when Ollama is unreachable', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new Error('ECONNREFUSED'));

    const { logger } = await import('./logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    await checkOllamaReachability();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: expect.any(String) }),
      expect.stringContaining('Ollama not reachable'),
    );

    warnSpy.mockRestore();
  });

  it('succeeds silently when Ollama is reachable', async () => {
    vi.mocked(Ollama.prototype.embed).mockResolvedValue(
      fakeEmbeddingResponse(1) as never,
    );

    const { logger } = await import('./logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    await checkOllamaReachability();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('never throws even on unexpected errors', async () => {
    vi.mocked(Ollama.prototype.embed).mockRejectedValue(new Error('unexpected'));

    await expect(checkOllamaReachability()).resolves.toBeUndefined();
  });
});
