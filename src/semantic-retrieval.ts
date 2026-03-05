import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { getDb, isSemanticsEnabled } from './db.js';
import { embed } from './embedding-service.js';
import { logger } from './logger.js';

export interface SemanticResult {
  sourceType: string;
  sourcePath: string;
  distance?: number; // undefined for FTS5-only results
  via: 'knn' | 'fts5';
}

const SEMANTIC_CONTEXT_MAX_CHARS = 4000;

/**
 * Hybrid semantic search combining KNN vector similarity and FTS5 keyword matching.
 *
 * Returns the most relevant memory files for the given group and query text.
 * Transparently falls back to FTS5-only when Ollama is unavailable (embed() returns null).
 * Returns [] immediately when semantic search is disabled entirely.
 *
 * Group isolation is enforced at query level via rowid IN (subquery) for KNN
 * and WHERE group_folder = ? for FTS5.
 */
export async function hybridSearch(
  groupFolder: string,
  queryText: string,
  opts?: { db?: Database.Database; topK?: number },
): Promise<SemanticResult[]> {
  if (!isSemanticsEnabled()) return [];

  const db = opts?.db ?? getDb();
  const K = opts?.topK ?? 5;

  const results: SemanticResult[] = [];
  const seen = new Set<string>();

  // Step 1: KNN — try semantic search; null return means Ollama unavailable
  const queryVector = await embed(queryText);
  if (queryVector) {
    try {
      const knnRows = db
        .prepare(
          `SELECT m.source_type, m.source_path, v.distance
           FROM vec_embeddings v
           JOIN embedding_meta m ON m.vec_rowid = v.rowid
           WHERE v.embedding MATCH ?
             AND k = ?
             AND v.rowid IN (SELECT vec_rowid FROM embedding_meta WHERE group_folder = ?)
           ORDER BY v.distance`,
        )
        .all(queryVector, K, groupFolder) as Array<{
        source_type: string;
        source_path: string;
        distance: number;
      }>;

      for (const row of knnRows) {
        if (!seen.has(row.source_path)) {
          seen.add(row.source_path);
          results.push({
            sourceType: row.source_type,
            sourcePath: row.source_path,
            distance: row.distance,
            via: 'knn',
          });
        }
      }
    } catch (err) {
      logger.warn({ err, groupFolder }, 'KNN query failed');
    }
  }

  // Step 2: FTS5 — keyword search for exact terms (names, dates, codes)
  const ftsQuery = buildFtsQuery(queryText);
  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT source_type, source_path
           FROM memory_fts
           WHERE memory_fts MATCH ? AND group_folder = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, groupFolder, K) as Array<{
        source_type: string;
        source_path: string;
      }>;

      for (const row of ftsRows) {
        if (!seen.has(row.source_path)) {
          seen.add(row.source_path);
          results.push({
            sourceType: row.source_type,
            sourcePath: row.source_path,
            via: 'fts5',
          });
        }
      }
    } catch (err) {
      logger.warn({ err, groupFolder, ftsQuery }, 'FTS5 query failed');
    }
  }

  return results;
}

/**
 * Build a safe FTS5 query string from raw user text.
 * Strips FTS5 special characters, filters short words, and joins with OR.
 * Returns null if no valid terms remain (prevents empty MATCH calls).
 */
export function buildFtsQuery(text: string): string | null {
  const words = text
    .replace(/["'*^()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 10);

  if (words.length === 0) return null;
  return words.join(' OR ');
}

/**
 * Read file content for each SemanticResult and format as a token-budgeted preamble.
 * Returns '' if results is empty or all files are missing/unreadable.
 *
 * Output format:
 *   ## Semantic Memory (Query-Relevant)
 *
 *   ### [sourceType] sourcePath
 *   <content>
 *   ---
 *   ...
 */
export function buildSemanticContext(
  groupFolder: string,
  results: SemanticResult[],
  opts?: { groupsDir?: string },
): string {
  if (results.length === 0) return '';

  const groupsDir = opts?.groupsDir ?? GROUPS_DIR;
  const groupDir = path.join(groupsDir, groupFolder);
  const parts: string[] = [];
  let totalChars = 0;

  for (const result of results) {
    if (totalChars >= SEMANTIC_CONTEXT_MAX_CHARS) break;

    const filePath = path.join(groupDir, result.sourcePath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const label = `[${result.sourceType}] ${result.sourcePath}`;
      const entry = `### ${label}\n\n${content.slice(0, 1000)}\n`;
      parts.push(entry);
      totalChars += entry.length;
    } catch {
      // file not found or unreadable — skip silently
    }
  }

  if (parts.length === 0) return '';

  return `## Semantic Memory (Query-Relevant)\n\n${parts.join('\n---\n\n')}`;
}
