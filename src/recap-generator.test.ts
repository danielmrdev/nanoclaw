import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db module before importing recap-generator
const mockDb = {};
vi.mock('./db.js', () => ({
  getMessagesForDateRange: vi.fn(),
  setLastRecapTimestamp: vi.fn(),
  isSemanticsEnabled: vi.fn(() => false),
  getDb: vi.fn(() => mockDb),
}));

// Mock embedding-service before importing recap-generator
vi.mock('./embedding-service.js', () => ({
  embed: vi.fn(),
  storeEmbedding: vi.fn(),
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
  generateMonthlyRecap,
  generateSemesterRecap,
  generateAnnualRecap,
  isoWeekToMonday,
  monthToFirstDay,
  semesterToFirstDay,
} from './recap-generator.js';
import { getMessagesForDateRange, setLastRecapTimestamp, isSemanticsEnabled } from './db.js';
import { embed, storeEmbedding } from './embedding-service.js';
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

// ---------------------------------------------------------------------------
// monthToFirstDay
// ---------------------------------------------------------------------------

describe('monthToFirstDay', () => {
  it('returns 2026-03-01T00:00:00.000Z for 2026-03', () => {
    const d = monthToFirstDay('2026-03');
    expect(d.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns 2026-01-01T00:00:00.000Z for 2026-01', () => {
    const d = monthToFirstDay('2026-01');
    expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns 2026-12-01T00:00:00.000Z for 2026-12', () => {
    const d = monthToFirstDay('2026-12');
    expect(d.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// semesterToFirstDay
// ---------------------------------------------------------------------------

describe('semesterToFirstDay', () => {
  it('returns 2026-01-01T00:00:00.000Z for 2026-S1', () => {
    const d = semesterToFirstDay('2026-S1');
    expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns 2026-07-01T00:00:00.000Z for 2026-S2', () => {
    const d = semesterToFirstDay('2026-S2');
    expect(d.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('throws on invalid semester string', () => {
    expect(() => semesterToFirstDay('2026-S3')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateMonthlyRecap
// ---------------------------------------------------------------------------

describe('generateMonthlyRecap', () => {
  it('writes stub file when no weekly notes exist', async () => {
    const result = await generateMonthlyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('No weekly notes available');
    expect(content).toContain('Monthly Recap — 2026-03');
  });

  it('writes monthly file with 3 weekly notes', async () => {
    const groupFolder = 'test-group';
    const weeklyDir = path.join(tempDir, groupFolder, 'daily', 'weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });

    // W10 Monday=2026-03-02, W11 Monday=2026-03-09, W12 Monday=2026-03-16
    fs.writeFileSync(
      path.join(weeklyDir, '2026-W10.md'),
      '# Weekly Recap — 2026-W10\n\nWeek 10 content.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(weeklyDir, '2026-W11.md'),
      '# Weekly Recap — 2026-W11\n\nWeek 11 content.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(weeklyDir, '2026-W12.md'),
      '# Weekly Recap — 2026-W12\n\nWeek 12 content.\n',
      'utf-8',
    );

    const result = await generateMonthlyRecap({
      groupFolder,
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Monthly Recap');
    expect(content).toContain('Week 10 content');
    expect(content).toContain('Week 11 content');
    expect(content).toContain('Week 12 content');
  });

  it('writes file to correct path: daily/monthly/YYYY-MM.md', async () => {
    const result = await generateMonthlyRecap({
      groupFolder: 'my-group',
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    expect(result.path).toContain(path.join('daily', 'monthly', '2026-03.md'));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('does NOT leave a .tmp file behind (atomic write)', async () => {
    const result = await generateMonthlyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('calls setLastRecapTimestamp with monthly cadence', async () => {
    await generateMonthlyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    expect(setLastRecapTimestamp).toHaveBeenCalledWith(
      'test-group',
      'monthly',
      expect.any(String),
    );
  });

  it('only includes weekly notes whose Monday falls within the month', async () => {
    const groupFolder = 'test-group';
    const weeklyDir = path.join(tempDir, groupFolder, 'daily', 'weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });

    // W09 Monday=2026-02-23 (February — should be excluded from March)
    fs.writeFileSync(
      path.join(weeklyDir, '2026-W09.md'),
      '# Weekly Recap — 2026-W09\n\nFeb week content.\n',
      'utf-8',
    );
    // W10 Monday=2026-03-02 (March — should be included)
    fs.writeFileSync(
      path.join(weeklyDir, '2026-W10.md'),
      '# Weekly Recap — 2026-W10\n\nMar week content.\n',
      'utf-8',
    );

    const result = await generateMonthlyRecap({
      groupFolder,
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Mar week content');
    expect(content).not.toContain('Feb week content');
  });
});

// ---------------------------------------------------------------------------
// generateSemesterRecap
// ---------------------------------------------------------------------------

describe('generateSemesterRecap', () => {
  it('writes stub file when no monthly notes exist', async () => {
    const result = await generateSemesterRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('No monthly notes available');
    expect(content).toContain('Semester Recap — 2026-S1');
  });

  it('writes semester file with 2 monthly notes', async () => {
    const groupFolder = 'test-group';
    const monthlyDir = path.join(tempDir, groupFolder, 'daily', 'monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });

    fs.writeFileSync(
      path.join(monthlyDir, '2026-01.md'),
      '# Monthly Recap — 2026-01\n\nJanuary content.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(monthlyDir, '2026-02.md'),
      '# Monthly Recap — 2026-02\n\nFebruary content.\n',
      'utf-8',
    );

    const result = await generateSemesterRecap({
      groupFolder,
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Semester Recap');
    expect(content).toContain('January content');
    expect(content).toContain('February content');
  });

  it('writes file to correct path: daily/semester/YYYY-Sn.md', async () => {
    const result = await generateSemesterRecap({
      groupFolder: 'my-group',
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    expect(result.path).toContain(
      path.join('daily', 'semester', '2026-S1.md'),
    );
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('does NOT leave a .tmp file behind (atomic write)', async () => {
    const result = await generateSemesterRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('calls setLastRecapTimestamp with semester cadence', async () => {
    await generateSemesterRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    expect(setLastRecapTimestamp).toHaveBeenCalledWith(
      'test-group',
      'semester',
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// generateAnnualRecap
// ---------------------------------------------------------------------------

describe('generateAnnualRecap', () => {
  it('writes stub file when no semester notes exist', async () => {
    const result = await generateAnnualRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('No semester notes available');
    expect(content).toContain('Annual Recap — 2026');
  });

  it('writes annual file with both semester notes', async () => {
    const groupFolder = 'test-group';
    const semesterDir = path.join(tempDir, groupFolder, 'daily', 'semester');
    fs.mkdirSync(semesterDir, { recursive: true });

    fs.writeFileSync(
      path.join(semesterDir, '2026-S1.md'),
      '# Semester Recap — 2026-S1\n\nFirst half content.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(semesterDir, '2026-S2.md'),
      '# Semester Recap — 2026-S2\n\nSecond half content.\n',
      'utf-8',
    );

    const result = await generateAnnualRecap({
      groupFolder,
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('Annual Recap');
    expect(content).toContain('First half content');
    expect(content).toContain('Second half content');
  });

  it('writes file to correct path: daily/annual/YYYY.md', async () => {
    const result = await generateAnnualRecap({
      groupFolder: 'my-group',
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    expect(result.path).toContain(path.join('daily', 'annual', '2026.md'));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('does NOT leave a .tmp file behind (atomic write)', async () => {
    const result = await generateAnnualRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
  });

  it('calls setLastRecapTimestamp with annual cadence', async () => {
    await generateAnnualRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    expect(setLastRecapTimestamp).toHaveBeenCalledWith(
      'test-group',
      'annual',
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Embedding hooks
// ---------------------------------------------------------------------------

describe('embedding hooks — isSemanticsEnabled=false', () => {
  it('generateDailyRecap returns written:true when semantics disabled', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(false);
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);

    const result = await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    expect(storeEmbedding).not.toHaveBeenCalled();
  });

  it('generateWeeklyRecap returns written:true when semantics disabled', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(false);

    const result = await generateWeeklyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    expect(result.written).toBe(true);
    expect(storeEmbedding).not.toHaveBeenCalled();
  });
});

describe('embedding hooks — isSemanticsEnabled=true, embed returns vector', () => {
  it('generateDailyRecap calls storeEmbedding with correct sourceType and relative path', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);
    const fakeVec = new Float32Array(768).fill(0.1);
    vi.mocked(embed).mockResolvedValue(fakeVec);

    await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    // Fire-and-forget: wait for microtasks to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(embed).toHaveBeenCalled();
    expect(storeEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      'test-group',
      'daily',
      'daily/2026-03/2026-03-05.md',
      expect.any(String),
      fakeVec,
    );
  });

  it('generateWeeklyRecap calls storeEmbedding with weekly sourceType', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    const fakeVec = new Float32Array(768).fill(0.2);
    vi.mocked(embed).mockResolvedValue(fakeVec);

    await generateWeeklyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      weekIso: '2026-W10',
      groupsDir: tempDir,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(storeEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      'test-group',
      'weekly',
      'daily/weekly/2026-W10.md',
      expect.any(String),
      fakeVec,
    );
  });

  it('generateMonthlyRecap calls storeEmbedding with monthly sourceType', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    const fakeVec = new Float32Array(768).fill(0.3);
    vi.mocked(embed).mockResolvedValue(fakeVec);

    await generateMonthlyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      monthIso: '2026-03',
      groupsDir: tempDir,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(storeEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      'test-group',
      'monthly',
      'daily/monthly/2026-03.md',
      expect.any(String),
      fakeVec,
    );
  });

  it('generateSemesterRecap calls storeEmbedding with semester sourceType', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    const fakeVec = new Float32Array(768).fill(0.4);
    vi.mocked(embed).mockResolvedValue(fakeVec);

    await generateSemesterRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      semIso: '2026-S1',
      groupsDir: tempDir,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(storeEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      'test-group',
      'semester',
      'daily/semester/2026-S1.md',
      expect.any(String),
      fakeVec,
    );
  });

  it('generateAnnualRecap calls storeEmbedding with annual sourceType', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    const fakeVec = new Float32Array(768).fill(0.5);
    vi.mocked(embed).mockResolvedValue(fakeVec);

    await generateAnnualRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      year: 2026,
      groupsDir: tempDir,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(storeEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      'test-group',
      'annual',
      'daily/annual/2026.md',
      expect.any(String),
      fakeVec,
    );
  });
});

describe('embedding hooks — isSemanticsEnabled=true, embed returns null (Ollama down)', () => {
  it('generateDailyRecap still returns written:true when embed returns null', async () => {
    vi.mocked(isSemanticsEnabled).mockReturnValue(true);
    vi.mocked(getMessagesForDateRange).mockReturnValue([]);
    vi.mocked(embed).mockResolvedValue(null);

    const result = await generateDailyRecap({
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      date: '2026-03-05',
      groupsDir: tempDir,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(result.written).toBe(true);
    expect(storeEmbedding).not.toHaveBeenCalled();
  });
});
