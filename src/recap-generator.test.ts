import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db module before importing recap-generator
vi.mock('./db.js', () => ({
  getMessagesForDateRange: vi.fn(),
  setLastRecapTimestamp: vi.fn(),
}));

// Mock the config module
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Nano',
  GROUPS_DIR: '',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  generateDailyRecap,
  generateWeeklyRecap,
  isoWeekToMonday,
} from './recap-generator.js';
import { getMessagesForDateRange, setLastRecapTimestamp } from './db.js';
import { GROUPS_DIR } from './config.js';

// Helper to set GROUPS_DIR dynamically in tests
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-test-'));
  // Override the GROUPS_DIR mock for each test
  vi.doMock('./config.js', () => ({
    ASSISTANT_NAME: 'Nano',
    GROUPS_DIR: tempDir,
  }));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isoWeekToMonday
// ---------------------------------------------------------------------------

describe('isoWeekToMonday', () => {
  it('returns Monday 2026-03-02 for 2026-W10', () => {
    const monday = isoWeekToMonday('2026-W10');
    expect(monday.toISOString().slice(0, 10)).toBe('2026-03-02');
  });

  it('returns Monday 2026-01-05 for 2026-W02', () => {
    const monday = isoWeekToMonday('2026-W02');
    expect(monday.toISOString().slice(0, 10)).toBe('2026-01-05');
  });

  it('throws on invalid ISO week string', () => {
    expect(() => isoWeekToMonday('bad-week')).toThrow('Invalid ISO week');
  });
});

// ---------------------------------------------------------------------------
// generateDailyRecap
// ---------------------------------------------------------------------------

describe('generateDailyRecap', () => {
  it('writes stub file when no messages exist', async () => {
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);

    const groupFolder = 'test-group';
    const groupDir = path.join(tempDir, groupFolder);

    const result = await generateDailyRecap({
      groupFolder,
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('No conversations today');
    expect(content).toContain('Daily Recap — 2026-03-05');
  });

  it('writes file with sender names when messages exist', async () => {
    vi.mocked(getMessagesForDateRange).mockReturnValue([
      {
        id: '1',
        chat_jid: 'test@g.us',
        sender: 'sender1',
        sender_name: 'Alice',
        content: 'Hello world',
        timestamp: '2026-03-05T10:00:00.000Z',
      },
      {
        id: '2',
        chat_jid: 'test@g.us',
        sender: 'sender2',
        sender_name: 'Bob',
        content: 'Hi there',
        timestamp: '2026-03-05T10:05:00.000Z',
      },
    ]);

    const result = await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Alice');
    expect(content).toContain('Bob');
    expect(content).toContain('Hello world');
    expect(content).toContain('Hi there');
  });

  it('writes file to correct path: daily/YYYY-MM/YYYY-MM-DD.md', async () => {
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);

    const result = await generateDailyRecap({
      groupFolder: 'my-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    expect(result.path).toContain(path.join('daily', '2026-03', '2026-03-05.md'));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('does NOT leave a .tmp file behind (atomic write)', async () => {
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);

    const result = await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('calls setLastRecapTimestamp after successful write', async () => {
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);

    await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    expect(setLastRecapTimestamp).toHaveBeenCalledWith(
      'test-group',
      'daily',
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// generateWeeklyRecap
// ---------------------------------------------------------------------------

describe('generateWeeklyRecap', () => {
  it('writes stub file when no daily notes exist', async () => {
    const result = await generateWeeklyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('No daily notes available');
    expect(content).toContain('Weekly Recap — 2026-W10');
  });

  it('writes weekly file with daily note content when notes exist', async () => {
    // Create a daily note for Monday 2026-03-02
    const groupFolder = 'test-group';
    const dailyDir = path.join(tempDir, groupFolder, 'daily', '2026-03');
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dailyDir, '2026-03-02.md'),
      '# Daily Recap — 2026-03-02\n\nTest content for Monday.\n',
      'utf-8',
    );

    const result = await generateWeeklyRecap({
      groupFolder,
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Weekly Recap — 2026-W10');
    expect(content).toContain('Test content for Monday');
    expect(content).toContain('2026-03-02');
  });

  it('writes file to correct path: daily/weekly/YYYY-Wnn.md', async () => {
    const result = await generateWeeklyRecap({
      groupFolder: 'my-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    expect(result.path).toContain(path.join('daily', 'weekly', '2026-W10.md'));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('does NOT leave a .tmp file behind (atomic write)', async () => {
    const result = await generateWeeklyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('calls setLastRecapTimestamp after successful write', async () => {
    await generateWeeklyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    expect(setLastRecapTimestamp).toHaveBeenCalledWith(
      'test-group',
      'weekly',
      expect.any(String),
    );
  });
});
