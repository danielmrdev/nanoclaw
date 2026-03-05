import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getLastRecapTimestamp } from './db.js';
import { logger } from './logger.js';

const ARCHIVE_AFTER_DAYS = parseInt(
  process.env.CONVERSATION_ARCHIVE_AFTER_DAYS || '30',
  10,
);
const ACTIVE_SESSION_GUARD_MS = 5 * 60 * 1000; // 5 minutes

export interface ArchiveResult {
  archived: string[];
  skipped: string[];
}

export interface ArchiveOptions {
  groupFolder: string;
  /** Override for GROUPS_DIR — used in tests to point at a temp directory. */
  groupsDir?: string;
}

/**
 * Move conversation files older than ARCHIVE_AFTER_DAYS to conversations/archive/YYYY-MM/.
 * Gated on:
 *   1. File is not actively being written (mtime > 5 min ago)
 *   2. A daily recap covering the file's period has completed (last_recap_timestamp set)
 *
 * NEVER deletes files — only moves them.
 */
export function archiveOldConversations(opts: ArchiveOptions): ArchiveResult {
  const { groupFolder, groupsDir = GROUPS_DIR } = opts;
  const groupDir = path.join(groupsDir, groupFolder);
  const conversationsDir = path.join(groupDir, 'conversations');

  if (!fs.existsSync(conversationsDir)) {
    return { archived: [], skipped: [] };
  }

  const archived: string[] = [];
  const skipped: string[] = [];

  // Get last recap timestamp — if no recap has ever run, don't archive anything
  const lastRecapTs = getLastRecapTimestamp(groupFolder, 'daily');
  if (!lastRecapTs) {
    logger.debug(
      { groupFolder },
      'No daily recap coverage yet — skipping conversation archival',
    );
    return { archived: [], skipped: [] };
  }
  const lastRecapDate = new Date(lastRecapTs);

  let entries: string[];
  try {
    entries = fs.readdirSync(conversationsDir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to read conversations directory');
    return { archived: [], skipped: [] };
  }

  for (const filename of entries) {
    const filePath = path.join(conversationsDir, filename);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      skipped.push(filename);
      continue;
    }

    const ageMs = Date.now() - stat.mtimeMs;

    // Active session guard: skip files modified in the last 5 minutes
    if (ageMs < ACTIVE_SESSION_GUARD_MS) {
      skipped.push(filename);
      continue;
    }

    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Not old enough
    if (ageDays <= ARCHIVE_AFTER_DAYS) {
      skipped.push(filename);
      continue;
    }

    // Gating: file's mtime must be before last recap timestamp
    // This ensures the window is covered before we move the file
    if (stat.mtime >= lastRecapDate) {
      skipped.push(filename);
      continue;
    }

    // Determine archive subdirectory from file's mtime
    const mtime = stat.mtime;
    const archiveMonth = `${mtime.getUTCFullYear()}-${String(mtime.getUTCMonth() + 1).padStart(2, '0')}`;
    const archiveDir = path.join(conversationsDir, 'archive', archiveMonth);

    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const destPath = path.join(archiveDir, filename);
      fs.renameSync(filePath, destPath);
      archived.push(filename);
      logger.info(
        { groupFolder, filename, archiveDir },
        'Archived conversation file',
      );
    } catch (err) {
      logger.warn(
        { groupFolder, filename, err },
        'Failed to archive conversation file',
      );
      skipped.push(filename);
    }
  }

  if (archived.length > 0) {
    logger.info(
      { groupFolder, count: archived.length },
      'Conversation archival complete',
    );
  }

  return { archived, skipped };
}
