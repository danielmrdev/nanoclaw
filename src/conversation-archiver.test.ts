import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db module
vi.mock('./db.js', () => ({
  getLastRecapTimestamp: vi.fn(),
}));

// Mock the config module
vi.mock('./config.js', () => ({
  GROUPS_DIR: '',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { archiveOldConversations } from './conversation-archiver.js';
import { getLastRecapTimestamp } from './db.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-test-'));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Helper: create a conversation file with a specific mtime
function createConversationFile(
  groupFolder: string,
  filename: string,
  mtimeDaysAgo: number,
): string {
  const conversationsDir = path.join(tempDir, groupFolder, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const filePath = path.join(conversationsDir, filename);
  fs.writeFileSync(filePath, `# Conversation\n\nTest content.`, 'utf-8');

  // Set mtime to N days ago
  const mtimeMs = Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000;
  const mtimeDate = new Date(mtimeMs);
  fs.utimesSync(filePath, mtimeDate, mtimeDate);

  return filePath;
}

// ---------------------------------------------------------------------------
// Returns empty when conversations/ does not exist
// ---------------------------------------------------------------------------

describe('archiveOldConversations', () => {
  it('returns empty result when conversations/ directory does not exist', () => {
    vi.mocked(getLastRecapTimestamp).mockReturnValue(
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const result = archiveOldConversations({
      groupFolder: 'nonexistent-group',
      groupsDir: tempDir,
    });

    expect(result).toEqual({ archived: [], skipped: [] });
  });

  // ---------------------------------------------------------------------------
  // Returns empty when no recap coverage
  // ---------------------------------------------------------------------------

  it('returns empty result when getLastRecapTimestamp returns null', () => {
    vi.mocked(getLastRecapTimestamp).mockReturnValue(null);

    // Create conversations dir with an old file
    createConversationFile('test-group', '2025-10-01.md', 40);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result).toEqual({ archived: [], skipped: [] });
    expect(getLastRecapTimestamp).toHaveBeenCalledWith('test-group', 'daily');
  });

  // ---------------------------------------------------------------------------
  // Active session guard: skip files modified in the last 5 minutes
  // ---------------------------------------------------------------------------

  it('skips files modified in the last 5 minutes (active session guard)', () => {
    vi.mocked(getLastRecapTimestamp).mockReturnValue(
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );

    // File modified 2 minutes ago — should be skipped
    createConversationFile('test-group', '2025-10-01.md', 0);
    // Override mtime to 2 minutes ago
    const filePath = path.join(
      tempDir,
      'test-group',
      'conversations',
      '2025-10-01.md',
    );
    const recentMtime = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(filePath, recentMtime, recentMtime);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toHaveLength(0);
    expect(result.skipped).toContain('2025-10-01.md');
  });

  // ---------------------------------------------------------------------------
  // Skips files <= 30 days old
  // ---------------------------------------------------------------------------

  it('skips files that are 30 days old or younger', () => {
    vi.mocked(getLastRecapTimestamp).mockReturnValue(
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );

    // Create a file that is exactly 25 days old
    createConversationFile('test-group', '2025-10-01.md', 25);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toHaveLength(0);
    expect(result.skipped).toContain('2025-10-01.md');
  });

  // ---------------------------------------------------------------------------
  // Skips non-.md files
  // ---------------------------------------------------------------------------

  it('only processes .md files (skips other extensions)', () => {
    vi.mocked(getLastRecapTimestamp).mockReturnValue(
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const conversationsDir = path.join(tempDir, 'test-group', 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });
    const txtPath = path.join(conversationsDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'not a markdown file');
    const oldMtime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(txtPath, oldMtime, oldMtime);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    // .txt file should not be archived or appear in skipped (it's filtered before processing)
    expect(result.archived).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Moves old files with recap coverage to archive/YYYY-MM/
  // ---------------------------------------------------------------------------

  it('moves files older than 30 days with recap coverage to archive/YYYY-MM/', () => {
    // Recap coverage: 60 days ago
    const recapTs = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(getLastRecapTimestamp).mockReturnValue(recapTs);

    // Create a file that is 40 days old (before the recap timestamp)
    const filePath = createConversationFile(
      'test-group',
      '2025-10-01.md',
      40,
    );

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toContain('2025-10-01.md');
    expect(result.skipped).not.toContain('2025-10-01.md');

    // Original file should be gone
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('creates archive/YYYY-MM/ directory if it does not exist', () => {
    const recapTs = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(getLastRecapTimestamp).mockReturnValue(recapTs);

    createConversationFile('test-group', '2025-10-01.md', 40);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toHaveLength(1);

    // Archive directory should now exist
    const conversationsDir = path.join(
      tempDir,
      'test-group',
      'conversations',
      'archive',
    );
    const entries = fs.readdirSync(conversationsDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('uses the file mtime (not today) to determine archive YYYY-MM/ subdirectory', () => {
    const recapTs = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(getLastRecapTimestamp).mockReturnValue(recapTs);

    // Set mtime to October 2025
    const filePath = createConversationFile(
      'test-group',
      '2025-10-01.md',
      40,
    );
    // Force an October mtime
    const octMtime = new Date('2025-10-01T12:00:00.000Z');
    fs.utimesSync(filePath, octMtime, octMtime);

    archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    const archiveDir = path.join(
      tempDir,
      'test-group',
      'conversations',
      'archive',
      '2025-10',
    );
    expect(fs.existsSync(archiveDir)).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, '2025-10-01.md'))).toBe(true);
  });

  it('archived file appears in archived[] result', () => {
    const recapTs = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(getLastRecapTimestamp).mockReturnValue(recapTs);

    createConversationFile('test-group', '2025-09-15.md', 40);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toContain('2025-09-15.md');
  });

  // ---------------------------------------------------------------------------
  // Files NOT covered by recap are skipped
  // ---------------------------------------------------------------------------

  it('skips files whose mtime is after last_recap_timestamp', () => {
    // Recap coverage: 35 days ago
    const recapTs = new Date(
      Date.now() - 35 * 24 * 60 * 60 * 1000,
    ).toISOString();
    vi.mocked(getLastRecapTimestamp).mockReturnValue(recapTs);

    // File is 31 days old (>30 threshold) but mtime is AFTER recap coverage
    // (i.e., recap is older than file — file not yet covered)
    createConversationFile('test-group', '2025-10-01.md', 31);

    const result = archiveOldConversations({
      groupFolder: 'test-group',
      groupsDir: tempDir,
    });

    expect(result.archived).toHaveLength(0);
    expect(result.skipped).toContain('2025-10-01.md');
  });
});
