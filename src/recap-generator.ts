import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import {
  getDb,
  getMessagesForDateRange,
  isSemanticsEnabled,
  setLastRecapTimestamp,
} from './db.js';
import { embed, storeEmbedding } from './embedding-service.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export interface RecapOptions {
  groupFolder: string;
  chatJid: string;
  /** Override for GROUPS_DIR — used in tests to point at a temp directory. */
  groupsDir?: string;
  /** Override db handle — used in tests. Production code omits this. */
  db?: Database.Database;
}

export interface DailyRecapOptions extends RecapOptions {
  date: string; // 'YYYY-MM-DD'
}

export interface WeeklyRecapOptions extends RecapOptions {
  weekIso: string; // 'YYYY-Wnn'
}

export interface MonthlyRecapOptions extends RecapOptions {
  monthIso: string; // 'YYYY-MM'
}

export interface SemesterRecapOptions extends RecapOptions {
  semIso: string; // 'YYYY-S1' | 'YYYY-S2'
}

export interface AnnualRecapOptions extends RecapOptions {
  year: number;
}

export interface RecapResult {
  written: boolean;
  path: string;
}

// --- Daily Recap ---

export async function generateDailyRecap(
  opts: DailyRecapOptions,
): Promise<RecapResult> {
  const { groupFolder, chatJid, date, groupsDir = GROUPS_DIR } = opts;
  const resolvedDb: Database.Database = opts.db ?? getDb();

  // Parse date boundaries (inclusive of full day, UTC)
  const dayStart = new Date(`${date}T00:00:00.000Z`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59.999Z`).toISOString();

  const messages = getMessagesForDateRange(
    chatJid,
    dayStart,
    dayEnd,
    ASSISTANT_NAME,
  );

  const content =
    messages.length > 0
      ? buildDailyContent(date, messages)
      : `# Daily Recap — ${date}\n\nNo conversations today.\n`;

  // Write to daily/YYYY-MM/YYYY-MM-DD.md
  const [year, month] = date.split('-');
  const groupDir = path.join(groupsDir, groupFolder);
  const targetDir = path.join(groupDir, 'daily', `${year}-${month}`);
  const targetPath = path.join(targetDir, `${date}.md`);
  const tmpPath = `${targetPath}.tmp`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  // Update coverage timestamp
  setLastRecapTimestamp(groupFolder, 'daily', dayStart);

  // Optional: promote durable facts to knowledge/_index.md (RECAP-04)
  promoteFacts(groupDir, content, date);

  logger.info({ groupFolder, date, path: targetPath }, 'Daily recap written');

  if (isSemanticsEnabled()) {
    const relativePath = `daily/${year}-${month}/${date}.md`;
    void embedContent(resolvedDb, groupFolder, 'daily', relativePath, content);
  }

  return { written: true, path: targetPath };
}

function buildDailyContent(date: string, messages: NewMessage[]): string {
  // Group messages into a readable transcript
  const transcript = messages
    .map(
      (m) => `**${m.sender_name}** [${m.timestamp.slice(11, 16)}]: ${m.content}`,
    )
    .join('\n');

  return [
    `# Daily Recap — ${date}`,
    '',
    '## Summary',
    `${messages.length} messages exchanged today.`,
    '',
    '## Conversation Log',
    transcript,
    '',
    '## Key Topics',
    '- (review above log)',
    '',
    '## Decisions & Actions',
    '- (none recorded)',
    '',
    '## Facts to Remember',
    '- (none recorded)',
    '',
    '## Open Questions',
    '- (none recorded)',
    '',
  ].join('\n');
}

/**
 * If the recap contains a non-empty "Facts to Remember" section,
 * append those facts to knowledge/_index.md (RECAP-04 optional promotion).
 * Uses atomic write: read existing → append → write to .tmp → rename.
 */
function promoteFacts(
  groupDir: string,
  recapContent: string,
  date: string,
): void {
  const factsMatch = recapContent.match(
    /## Facts to Remember\n([\s\S]*?)(?=\n## |\n$|$)/,
  );
  if (!factsMatch) return;

  const factsBlock = factsMatch[1].trim();
  // Skip if only placeholder
  if (!factsBlock || factsBlock === '- (none recorded)') return;

  const indexPath = path.join(groupDir, 'knowledge', '_index.md');
  const tmpPath = `${indexPath}.tmp`;
  const appendSection = `\n\n## Facts from ${date}\n\n${factsBlock}\n`;

  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const existing = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, 'utf-8')
      : '# Knowledge Index\n';
    fs.writeFileSync(tmpPath, existing + appendSection, 'utf-8');
    fs.renameSync(tmpPath, indexPath);
    logger.info({ date }, 'Promoted facts to knowledge/_index.md');
  } catch (err) {
    logger.warn(
      { err },
      'Failed to promote facts to knowledge index — skipping',
    );
  }
}

// --- Weekly Recap ---

export async function generateWeeklyRecap(
  opts: WeeklyRecapOptions,
): Promise<RecapResult> {
  const { groupFolder, chatJid: _chatJid, weekIso, groupsDir = GROUPS_DIR } = opts;
  const resolvedDb: Database.Database = opts.db ?? getDb();
  const groupDir = path.join(groupsDir, groupFolder);

  // Collect daily notes for this week (Mon–Sun)
  const dailyNotes = collectDailyNotesForWeek(groupDir, weekIso);

  const content =
    dailyNotes.length > 0
      ? buildWeeklyContent(weekIso, dailyNotes)
      : `# Weekly Recap — ${weekIso}\n\nNo daily notes available for this week.\n`;

  // Write to daily/weekly/YYYY-Wnn.md
  const targetDir = path.join(groupDir, 'daily', 'weekly');
  const targetPath = path.join(targetDir, `${weekIso}.md`);
  const tmpPath = `${targetPath}.tmp`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  // Update coverage timestamp
  const weekStart = isoWeekToMonday(weekIso).toISOString();
  setLastRecapTimestamp(groupFolder, 'weekly', weekStart);

  logger.info({ groupFolder, weekIso, path: targetPath }, 'Weekly recap written');

  if (isSemanticsEnabled()) {
    const relativePath = `daily/weekly/${weekIso}.md`;
    void embedContent(resolvedDb, groupFolder, 'weekly', relativePath, content);
  }

  return { written: true, path: targetPath };
}

/**
 * Resolve the 7 daily .md files that belong to the given ISO week.
 * ISO week starts Monday.
 */
function collectDailyNotesForWeek(
  groupDir: string,
  weekIso: string,
): Array<{ date: string; content: string }> {
  const monday = isoWeekToMonday(weekIso);
  const notes: Array<{ date: string; content: string }> = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const [year, month] = dateStr.split('-');
    const notePath = path.join(
      groupDir,
      'daily',
      `${year}-${month}`,
      `${dateStr}.md`,
    );
    if (fs.existsSync(notePath)) {
      notes.push({ date: dateStr, content: fs.readFileSync(notePath, 'utf-8') });
    }
  }

  return notes;
}

function buildWeeklyContent(
  weekIso: string,
  dailyNotes: Array<{ date: string; content: string }>,
): string {
  const notesSections = dailyNotes
    .map(({ date, content }) => `## ${date}\n\n${content.trim()}`)
    .join('\n\n---\n\n');

  return [
    `# Weekly Recap — ${weekIso}`,
    '',
    '## Week Overview',
    `${dailyNotes.length} days with conversations this week.`,
    '',
    '## Daily Notes',
    '',
    notesSections,
    '',
    '## Recurring Themes',
    '- (review daily notes above)',
    '',
    '## Key Decisions',
    '- (none recorded)',
    '',
    '## Durable Knowledge',
    '- (none recorded)',
    '',
    '## Next Week Context',
    '(carry forward as needed)',
    '',
  ].join('\n');
}

// --- Monthly Recap ---

export async function generateMonthlyRecap(
  opts: MonthlyRecapOptions,
): Promise<RecapResult> {
  const { groupFolder, chatJid: _chatJid, monthIso, groupsDir = GROUPS_DIR } = opts;
  const resolvedDb: Database.Database = opts.db ?? getDb();
  const groupDir = path.join(groupsDir, groupFolder);

  const weeklyNotes = collectWeeklyNotesForMonth(groupDir, monthIso);

  const content =
    weeklyNotes.length > 0
      ? buildMonthlyContent(monthIso, weeklyNotes)
      : `# Monthly Recap — ${monthIso}\n\nNo weekly notes available.\n`;

  const targetDir = path.join(groupDir, 'daily', 'monthly');
  const targetPath = path.join(targetDir, `${monthIso}.md`);
  const tmpPath = `${targetPath}.tmp`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  setLastRecapTimestamp(groupFolder, 'monthly', monthToFirstDay(monthIso).toISOString());

  logger.info({ groupFolder, monthIso, path: targetPath }, 'Monthly recap written');

  if (isSemanticsEnabled()) {
    const relativePath = `daily/monthly/${monthIso}.md`;
    void embedContent(resolvedDb, groupFolder, 'monthly', relativePath, content);
  }

  return { written: true, path: targetPath };
}

// --- Semester Recap ---

export async function generateSemesterRecap(
  opts: SemesterRecapOptions,
): Promise<RecapResult> {
  const { groupFolder, chatJid: _chatJid, semIso, groupsDir = GROUPS_DIR } = opts;
  const resolvedDb: Database.Database = opts.db ?? getDb();
  const groupDir = path.join(groupsDir, groupFolder);

  const monthlyNotes = collectMonthlyNotesForSemester(groupDir, semIso);

  const content =
    monthlyNotes.length > 0
      ? buildSemesterContent(semIso, monthlyNotes)
      : `# Semester Recap — ${semIso}\n\nNo monthly notes available.\n`;

  const targetDir = path.join(groupDir, 'daily', 'semester');
  const targetPath = path.join(targetDir, `${semIso}.md`);
  const tmpPath = `${targetPath}.tmp`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  setLastRecapTimestamp(groupFolder, 'semester', semesterToFirstDay(semIso).toISOString());

  logger.info({ groupFolder, semIso, path: targetPath }, 'Semester recap written');

  if (isSemanticsEnabled()) {
    const relativePath = `daily/semester/${semIso}.md`;
    void embedContent(resolvedDb, groupFolder, 'semester', relativePath, content);
  }

  return { written: true, path: targetPath };
}

// --- Annual Recap ---

export async function generateAnnualRecap(
  opts: AnnualRecapOptions,
): Promise<RecapResult> {
  const { groupFolder, chatJid: _chatJid, year, groupsDir = GROUPS_DIR } = opts;
  const resolvedDb: Database.Database = opts.db ?? getDb();
  const groupDir = path.join(groupsDir, groupFolder);

  const semesterNotes = collectSemesterNotesForYear(groupDir, year);

  const content =
    semesterNotes.length > 0
      ? buildAnnualContent(year, semesterNotes)
      : `# Annual Recap — ${year}\n\nNo semester notes available.\n`;

  const targetDir = path.join(groupDir, 'daily', 'annual');
  const targetPath = path.join(targetDir, `${year}.md`);
  const tmpPath = `${targetPath}.tmp`;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  setLastRecapTimestamp(
    groupFolder,
    'annual',
    new Date(Date.UTC(year, 0, 1)).toISOString(),
  );

  logger.info({ groupFolder, year, path: targetPath }, 'Annual recap written');

  if (isSemanticsEnabled()) {
    const relativePath = `daily/annual/${year}.md`;
    void embedContent(resolvedDb, groupFolder, 'annual', relativePath, content);
  }

  return { written: true, path: targetPath };
}

// --- Embedding hook ---

async function embedContent(
  db: Database.Database,
  groupFolder: string,
  sourceType: string,
  sourcePath: string,
  content: string,
): Promise<void> {
  try {
    const vector = await embed(content);
    if (vector) {
      storeEmbedding(db, groupFolder, sourceType, sourcePath, content, vector);
    }
  } catch (err) {
    logger.warn({ err, groupFolder, sourceType, sourcePath }, 'embedContent failed');
  }
}

// --- Content builders ---

function buildMonthlyContent(
  monthIso: string,
  weeklyNotes: Array<{ weekIso: string; content: string }>,
): string {
  const notesSections = weeklyNotes
    .map(({ weekIso, content }) => `## ${weekIso}\n\n${content.trim()}`)
    .join('\n\n---\n\n');

  return [
    `# Monthly Recap — ${monthIso}`,
    '',
    '## Month Overview',
    `${weeklyNotes.length} weeks with notes this month.`,
    '',
    '## Weekly Notes',
    '',
    notesSections,
    '',
    '## Recurring Themes',
    '- (review weekly notes above)',
    '',
    '## Key Decisions',
    '- (none recorded)',
    '',
    '## Durable Knowledge',
    '- (none recorded)',
    '',
  ].join('\n');
}

function buildSemesterContent(
  semIso: string,
  monthlyNotes: Array<{ monthIso: string; content: string }>,
): string {
  const notesSections = monthlyNotes
    .map(({ monthIso, content }) => `## ${monthIso}\n\n${content.trim()}`)
    .join('\n\n---\n\n');

  return [
    `# Semester Recap — ${semIso}`,
    '',
    '## Semester Overview',
    `${monthlyNotes.length} months with notes this semester.`,
    '',
    '## Monthly Notes',
    '',
    notesSections,
    '',
    '## Recurring Themes',
    '- (review monthly notes above)',
    '',
    '## Key Decisions',
    '- (none recorded)',
    '',
    '## Durable Knowledge',
    '- (none recorded)',
    '',
  ].join('\n');
}

function buildAnnualContent(
  year: number,
  semesterNotes: Array<{ semIso: string; content: string }>,
): string {
  const notesSections = semesterNotes
    .map(({ semIso, content }) => `## ${semIso}\n\n${content.trim()}`)
    .join('\n\n---\n\n');

  return [
    `# Annual Recap — ${year}`,
    '',
    '## Year Overview',
    `${semesterNotes.length} semesters with notes this year.`,
    '',
    '## Semester Notes',
    '',
    notesSections,
    '',
    '## Recurring Themes',
    '- (review semester notes above)',
    '',
    '## Key Decisions',
    '- (none recorded)',
    '',
    '## Durable Knowledge',
    '- (none recorded)',
    '',
  ].join('\n');
}

// --- Collect helpers ---

function collectWeeklyNotesForMonth(
  groupDir: string,
  monthIso: string,
): Array<{ weekIso: string; content: string }> {
  const weeklyDir = path.join(groupDir, 'daily', 'weekly');
  if (!fs.existsSync(weeklyDir)) return [];

  const [year, month] = monthIso.split('-').map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1)); // exclusive: first day of next month

  const files = fs.readdirSync(weeklyDir).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f));
  const notes: Array<{ weekIso: string; content: string }> = [];

  for (const file of files.sort()) {
    const weekIso = file.replace('.md', '');
    const monday = isoWeekToMonday(weekIso);
    if (monday >= monthStart && monday < monthEnd) {
      const notePath = path.join(weeklyDir, file);
      notes.push({ weekIso, content: fs.readFileSync(notePath, 'utf-8') });
    }
  }

  return notes;
}

function collectMonthlyNotesForSemester(
  groupDir: string,
  semIso: string,
): Array<{ monthIso: string; content: string }> {
  const monthlyDir = path.join(groupDir, 'daily', 'monthly');
  if (!fs.existsSync(monthlyDir)) return [];

  const match = semIso.match(/^(\d{4})-S([12])$/);
  if (!match) throw new Error(`Invalid semester string: ${semIso}`);
  const year = match[1];
  const sem = parseInt(match[2], 10);

  const months =
    sem === 1
      ? ['01', '02', '03', '04', '05', '06']
      : ['07', '08', '09', '10', '11', '12'];

  const notes: Array<{ monthIso: string; content: string }> = [];
  for (const m of months) {
    const monthIso = `${year}-${m}`;
    const notePath = path.join(monthlyDir, `${monthIso}.md`);
    if (fs.existsSync(notePath)) {
      notes.push({ monthIso, content: fs.readFileSync(notePath, 'utf-8') });
    }
  }

  return notes;
}

function collectSemesterNotesForYear(
  groupDir: string,
  year: number,
): Array<{ semIso: string; content: string }> {
  const semesterDir = path.join(groupDir, 'daily', 'semester');
  if (!fs.existsSync(semesterDir)) return [];

  const notes: Array<{ semIso: string; content: string }> = [];
  for (const sem of ['S1', 'S2']) {
    const semIso = `${year}-${sem}`;
    const notePath = path.join(semesterDir, `${semIso}.md`);
    if (fs.existsSync(notePath)) {
      notes.push({ semIso, content: fs.readFileSync(notePath, 'utf-8') });
    }
  }

  return notes;
}

// --- Date helpers ---

/**
 * Convert a month string (e.g. '2026-03') to the first day of that month (UTC).
 */
export function monthToFirstDay(monthIso: string): Date {
  const [year, month] = monthIso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Convert a semester string (e.g. '2026-S1' or '2026-S2') to its first day (UTC).
 * S1 = Jan 1, S2 = Jul 1.
 */
export function semesterToFirstDay(semIso: string): Date {
  const match = semIso.match(/^(\d{4})-S([12])$/);
  if (!match) throw new Error(`Invalid semester string: ${semIso}`);
  const year = parseInt(match[1], 10);
  const sem = parseInt(match[2], 10);
  return new Date(Date.UTC(year, sem === 1 ? 0 : 6, 1));
}

/**
 * Convert an ISO week string (e.g. '2026-W10') to the Monday of that week (UTC).
 */
export function isoWeekToMonday(weekIso: string): Date {
  const match = weekIso.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week: ${weekIso}`);
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);

  // Jan 4 is always in week 1 (ISO 8601)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Make Sunday = 7
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  return monday;
}
