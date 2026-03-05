import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { getAllRegisteredGroups, getDb, isSemanticsEnabled } from './db.js';
import { batchEmbed, contentHash, storeEmbedding } from './embedding-service.js';
import { logger } from './logger.js';

const BACKFILL_BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || '50', 10);

export interface BackfillResult {
  indexed: number;
  skipped: number; // already up-to-date (hash match)
  failed: number; // batchEmbed returned null for this batch
}

interface EmbeddableFile {
  absolutePath: string;
  sourcePath: string; // relative to groups/{groupFolder}/
  sourceType: string;
}

// Yield to event loop — lets NanoClaw process messages between backfill batches
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Split array into sub-arrays of at most `size` elements — no lodash
function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, (i + 1) * size),
  );
}

function needsEmbedding(
  db: Database.Database,
  groupFolder: string,
  sourceType: string,
  sourcePath: string,
  content: string,
): boolean {
  const hash = contentHash(content);
  const existing = db
    .prepare(
      `SELECT id FROM embedding_meta
       WHERE group_folder = ? AND source_type = ? AND source_path = ? AND content_hash = ?`,
    )
    .get(groupFolder, sourceType, sourcePath, hash);
  return !existing;
}

function collectEmbeddableFiles(groupDir: string): EmbeddableFile[] {
  const files: EmbeddableFile[] = [];

  // daily/{YYYY-MM}/*.md → sourceType='daily'
  const dailyRoot = path.join(groupDir, 'daily');
  if (fs.existsSync(dailyRoot)) {
    const dailyEntries = fs.readdirSync(dailyRoot, { withFileTypes: true });
    for (const entry of dailyEntries) {
      if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) {
        const monthDir = path.join(dailyRoot, entry.name);
        for (const f of fs.readdirSync(monthDir)) {
          if (f.endsWith('.md') && !f.endsWith('.tmp')) {
            files.push({
              absolutePath: path.join(monthDir, f),
              sourcePath: `daily/${entry.name}/${f}`,
              sourceType: 'daily',
            });
          }
        }
      } else if (entry.isDirectory() && entry.name === 'weekly') {
        const weeklyDir = path.join(dailyRoot, 'weekly');
        for (const f of fs.readdirSync(weeklyDir)) {
          if (f.endsWith('.md') && !f.endsWith('.tmp')) {
            files.push({
              absolutePath: path.join(weeklyDir, f),
              sourcePath: `daily/weekly/${f}`,
              sourceType: 'weekly',
            });
          }
        }
      } else if (entry.isDirectory() && entry.name === 'monthly') {
        const monthlyDir = path.join(dailyRoot, 'monthly');
        for (const f of fs.readdirSync(monthlyDir)) {
          if (f.endsWith('.md') && !f.endsWith('.tmp')) {
            files.push({
              absolutePath: path.join(monthlyDir, f),
              sourcePath: `daily/monthly/${f}`,
              sourceType: 'monthly',
            });
          }
        }
      } else if (entry.isDirectory() && entry.name === 'semester') {
        const semDir = path.join(dailyRoot, 'semester');
        for (const f of fs.readdirSync(semDir)) {
          if (f.endsWith('.md') && !f.endsWith('.tmp')) {
            files.push({
              absolutePath: path.join(semDir, f),
              sourcePath: `daily/semester/${f}`,
              sourceType: 'semester',
            });
          }
        }
      } else if (entry.isDirectory() && entry.name === 'annual') {
        const annualDir = path.join(dailyRoot, 'annual');
        for (const f of fs.readdirSync(annualDir)) {
          if (f.endsWith('.md') && !f.endsWith('.tmp')) {
            files.push({
              absolutePath: path.join(annualDir, f),
              sourcePath: `daily/annual/${f}`,
              sourceType: 'annual',
            });
          }
        }
      }
    }
  }

  // knowledge/*.md (exclude _index.md, _archive/, .tmp)
  const knowledgeDir = path.join(groupDir, 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    for (const f of fs.readdirSync(knowledgeDir)) {
      if (
        f.endsWith('.md') &&
        !f.endsWith('.tmp') &&
        f !== '_index.md' &&
        !f.startsWith('_archive')
      ) {
        files.push({
          absolutePath: path.join(knowledgeDir, f),
          sourcePath: `knowledge/${f}`,
          sourceType: 'fact',
        });
      }
    }
  }

  return files;
}

export async function backfillGroupEmbeddings(
  groupFolder: string,
  opts?: { groupsDir?: string; db?: Database.Database },
): Promise<BackfillResult> {
  if (!isSemanticsEnabled()) {
    return { indexed: 0, skipped: 0, failed: 0 };
  }

  const groupsDir = opts?.groupsDir ?? GROUPS_DIR;
  const db = opts?.db ?? getDb();
  const groupDir = path.join(groupsDir, groupFolder);

  if (!fs.existsSync(groupDir)) {
    logger.warn({ groupFolder }, 'backfillGroupEmbeddings: group directory not found');
    return { indexed: 0, skipped: 0, failed: 0 };
  }

  const allFiles = collectEmbeddableFiles(groupDir);
  const result: BackfillResult = { indexed: 0, skipped: 0, failed: 0 };

  const batches = chunk(allFiles, BACKFILL_BATCH_SIZE);

  for (const batch of batches) {
    // Read content and filter by hash — avoid calling Ollama for unchanged files
    const needsUpdate: Array<EmbeddableFile & { content: string }> = [];

    for (const file of batch) {
      let content: string;
      try {
        content = fs.readFileSync(file.absolutePath, 'utf-8');
      } catch {
        result.failed++;
        continue;
      }
      if (needsEmbedding(db, groupFolder, file.sourceType, file.sourcePath, content)) {
        needsUpdate.push({ ...file, content });
      } else {
        result.skipped++;
      }
    }

    if (needsUpdate.length === 0) {
      await yieldLoop();
      continue;
    }

    const vectors = await batchEmbed(needsUpdate.map((f) => f.content));
    if (!vectors) {
      result.failed += needsUpdate.length;
      await yieldLoop();
      continue;
    }

    for (let i = 0; i < needsUpdate.length; i++) {
      storeEmbedding(
        db,
        groupFolder,
        needsUpdate[i].sourceType,
        needsUpdate[i].sourcePath,
        needsUpdate[i].content,
        vectors[i],
      );
      result.indexed++;
    }

    await yieldLoop();
  }

  logger.info({ groupFolder, ...result }, 'Backfill complete');
  return result;
}

export async function backfillAllGroups(opts?: {
  groupsDir?: string;
  db?: Database.Database;
}): Promise<Record<string, BackfillResult>> {
  const groups = getAllRegisteredGroups();
  const results: Record<string, BackfillResult> = {};

  for (const [, group] of Object.entries(groups)) {
    results[group.folder] = await backfillGroupEmbeddings(group.folder, opts);
  }

  return results;
}
