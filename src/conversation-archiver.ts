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

export interface DeleteResult {
  deleted: string[];
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

/**
 * Delete archived conversation files older than DELETE_AFTER_DAYS (default 90).
 * Gated on monthly recap coverage — if no monthly recap has run, nothing is deleted.
 * Scans conversations/archive/YYYY-MM/ subdirectories for .md files.
 */
export function deleteOldArchives(opts: ArchiveOptions): DeleteResult {
  const { groupFolder, groupsDir = GROUPS_DIR } = opts;

  // Read env var at call time so test stubs (vi.stubEnv) take effect
  const deleteAfterDays = parseInt(
    process.env.CONVERSATION_DELETE_AFTER_DAYS || '90',
    10,
  );

  // Gate: monthly recap must have run at least once
  const lastMonthlyRecap = getLastRecapTimestamp(groupFolder, 'monthly');
  if (!lastMonthlyRecap) {
    logger.debug(
      { groupFolder },
      'No monthly recap coverage yet — skipping archive deletion',
    );
    return { deleted: [], skipped: [] };
  }

  const archiveDir = path.join(
    groupsDir,
    groupFolder,
    'conversations',
    'archive',
  );

  if (!fs.existsSync(archiveDir)) {
    return { deleted: [], skipped: [] };
  }

  const deleted: string[] = [];
  const skipped: string[] = [];

  let monthDirs: string[];
  try {
    monthDirs = fs.readdirSync(archiveDir).filter((entry) => {
      // Only YYYY-MM directories
      return /^\d{4}-\d{2}$/.test(entry);
    });
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to read archive directory');
    return { deleted: [], skipped: [] };
  }

  for (const monthDir of monthDirs) {
    const monthPath = path.join(archiveDir, monthDir);

    let files: string[];
    try {
      files = fs.readdirSync(monthPath).filter((f) => f.endsWith('.md'));
    } catch (err) {
      logger.warn({ groupFolder, monthDir, err }, 'Failed to read archive month directory');
      continue;
    }

    for (const filename of files) {
      const filePath = path.join(monthPath, filename);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        logger.warn({ groupFolder, filename, err }, 'Failed to stat archive file');
        skipped.push(filename);
        continue;
      }

      const ageMs = Date.now() - stat.mtimeMs;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays > deleteAfterDays) {
        try {
          fs.unlinkSync(filePath);
          deleted.push(filename);
          logger.info({ groupFolder, filename }, 'Deleted old archive file');
        } catch (err) {
          logger.warn({ groupFolder, filename, err }, 'Failed to delete archive file');
          skipped.push(filename);
        }
      } else {
        skipped.push(filename);
      }
    }
  }

  logger.info(
    { groupFolder, deleted: deleted.length, skipped: skipped.length },
    'Archive deletion complete',
  );

  return { deleted, skipped };
}
