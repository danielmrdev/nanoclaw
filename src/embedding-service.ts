import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { Ollama } from 'ollama';

import { EMBEDDING_MODEL, OLLAMA_HOST } from './config.js';
import { logger } from './logger.js';

// Lazy-initialized Ollama client — avoids import-time side effects and
// enables vi.mock('ollama') to replace the constructor in tests.
let ollamaClient: Ollama | null = null;

function getClient(): Ollama {
  if (!ollamaClient) {
    ollamaClient = new Ollama({ host: OLLAMA_HOST });
  }
  return ollamaClient;
}

/** @internal - for tests only. Clears the lazy singleton so vi.mock takes effect. */
export function _resetClient(): void {
  ollamaClient = null;
}

/**
 * Embed a single text string using Ollama.
 * Returns a Float32Array of EMBEDDING_DIM floats on success.
 * Returns null on any error — never throws.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  try {
    const response = await getClient().embed({
      model: EMBEDDING_MODEL,
      input: text,
    });
    return new Float32Array(response.embeddings[0]);
  } catch (err) {
    logger.debug({ err }, 'embed() failed');
    return null;
  }
}

/**
 * Embed multiple text strings in a single Ollama request.
 * Returns Float32Array[] on success, null on any error — never throws.
 */
export async function batchEmbed(
  texts: string[],
): Promise<Float32Array[] | null> {
  try {
    const response = await getClient().embed({
      model: EMBEDDING_MODEL,
      input: texts,
    });
    return response.embeddings.map((e) => new Float32Array(e));
  } catch (err) {
    logger.debug({ err }, 'batchEmbed() failed');
    return null;
  }
}

/**
 * Compute a SHA-256 hex digest of a UTF-8 string.
 * Pure function — no I/O.
 */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Store a vector embedding with its metadata in the database.
 * Uses content-based deduplication:
 * - If a row already exists with the same (group_folder, source_type, source_path, content_hash) → no-op.
 * - If a row exists for the same path but different hash (content changed) → delete old row, insert new.
 *
 * Uses better-sqlite3 synchronous API. Wrap insert pair in a transaction for atomicity.
 */
export function storeEmbedding(
  db: Database.Database,
  groupFolder: string,
  sourceType: string,
  sourcePath: string,
  text: string,
  vector: Float32Array,
): void {
  const hash = contentHash(text);

  // Check for unchanged content — exit early if nothing changed
  const existing = db
    .prepare(
      `SELECT id FROM embedding_meta
       WHERE group_folder = ? AND source_type = ? AND source_path = ? AND content_hash = ?`,
    )
    .get(groupFolder, sourceType, sourcePath, hash);

  if (existing) {
    return;
  }

  // Check for stale embedding (same path, different hash — content changed)
  const stale = db
    .prepare(
      `SELECT id, vec_rowid FROM embedding_meta
       WHERE group_folder = ? AND source_type = ? AND source_path = ?`,
    )
    .get(groupFolder, sourceType, sourcePath) as
    | { id: number; vec_rowid: number }
    | undefined;

  const doInsert = db.transaction(() => {
    if (stale) {
      db.prepare('DELETE FROM vec_embeddings WHERE rowid = ?').run(
        stale.vec_rowid,
      );
      db.prepare('DELETE FROM embedding_meta WHERE id = ?').run(stale.id);
    }

    const insertVec = db.prepare(
      'INSERT INTO vec_embeddings(embedding) VALUES (?)',
    );
    const vecResult = insertVec.run(vector);
    const vecRowid = vecResult.lastInsertRowid;

    db.prepare(
      `INSERT INTO embedding_meta
         (group_folder, source_type, source_path, content_hash, vec_rowid, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      groupFolder,
      sourceType,
      sourcePath,
      hash,
      vecRowid,
      new Date().toISOString(),
    );
  });

  doInsert();
}

/**
 * Delete a stored embedding by its composite key (groupFolder, sourceType, sourcePath).
 * If no matching row exists, returns without error (no-op).
 * Deletes from both vec_embeddings and embedding_meta in a single transaction.
 */
export function deleteEmbedding(
  db: Database.Database,
  groupFolder: string,
  sourceType: string,
  sourcePath: string,
): void {
  const row = db
    .prepare(
      `SELECT id, vec_rowid FROM embedding_meta
       WHERE group_folder = ? AND source_type = ? AND source_path = ?`,
    )
    .get(groupFolder, sourceType, sourcePath) as
    | { id: number; vec_rowid: number }
    | undefined;
  if (!row) return;
  db.transaction(() => {
    db.prepare('DELETE FROM vec_embeddings WHERE rowid = ?').run(row.vec_rowid);
    db.prepare('DELETE FROM embedding_meta WHERE id = ?').run(row.id);
  })();
}

/**
 * Probe Ollama reachability at startup.
 * Logs an info message on success, a pino warning on failure.
 * Never throws — intended to be fire-and-forget.
 */
export async function checkOllamaReachability(): Promise<void> {
  try {
    await getClient().embed({ model: EMBEDDING_MODEL, input: 'ping' });
    logger.info(
      { host: OLLAMA_HOST, model: EMBEDDING_MODEL },
      'Ollama reachable — semantic search enabled',
    );
  } catch (err) {
    logger.warn(
      { host: OLLAMA_HOST, err },
      'Ollama not reachable — semantic search disabled until available',
    );
  }
}
