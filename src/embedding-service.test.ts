import { describe, it, expect, vi, beforeEach } from 'vitest';

import { _initTestDatabase, _getTestDb, isSemanticsEnabled } from './db.js';
import {
  embed,
  batchEmbed,
  contentHash,
  storeEmbedding,
  checkOllamaReachability,
  _resetClient,
} from './embedding-service.js';
import { EMBEDDING_DIM } from './config.js';

// Mock the ollama package so tests never hit the network
vi.mock('ollama', () => {
  const mockEmbed = vi.fn();
  const MockOllama = vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
  }));
  return { Ollama: MockOllama, __mockEmbed: mockEmbed };
});

// Helper to get the mock embed function from the mocked module
async function getMockEmbed(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('ollama');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockEmbed as ReturnType<typeof vi.fn>;
}

// Build a fake 768-float response
function fakeEmbeddingResponse(count = 1): { embeddings: number[][] } {
  const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
  return { embeddings: Array.from({ length: count }, () => vec) };
}

beforeEach(async () => {
  _resetClient();
  const mockEmbed = await getMockEmbed();
  mockEmbed.mockReset();
});

// --- embed() ---

describe('embed()', () => {
  it('returns Float32Array of length EMBEDDING_DIM on success', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockResolvedValue(fakeEmbeddingResponse(1));

    const result = await embed('hello');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result!.length).toBe(EMBEDDING_DIM);
  });

  it('returns null when Ollama client throws (connection refused)', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await embed('hello');

    expect(result).toBeNull();
  });

  it('never throws even on unexpected errors', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new TypeError('unexpected'));

    await expect(embed('hello')).resolves.toBeNull();
  });
});

// --- batchEmbed() ---

describe('batchEmbed()', () => {
  it('returns Float32Array[] of correct length on success', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockResolvedValue(fakeEmbeddingResponse(2));

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
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await batchEmbed(['a', 'b']);

    expect(result).toBeNull();
  });

  it('never throws even on unexpected errors', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new TypeError('unexpected'));

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

// --- checkOllamaReachability() ---

describe('checkOllamaReachability()', () => {
  it('logs warning when Ollama is unreachable', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new Error('ECONNREFUSED'));

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
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockResolvedValue(fakeEmbeddingResponse(1));

    const { logger } = await import('./logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    await checkOllamaReachability();

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('never throws even on unexpected errors', async () => {
    const mockEmbed = await getMockEmbed();
    mockEmbed.mockRejectedValue(new Error('unexpected'));

    await expect(checkOllamaReachability()).resolves.toBeUndefined();
  });
});
