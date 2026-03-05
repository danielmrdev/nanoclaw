import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { getMessagesForDateRange, setLastRecapTimestamp } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export interface RecapOptions {
  groupFolder: string;
  chatJid: string;
  /** Override for GROUPS_DIR — used in tests to point at a temp directory. */
  groupsDir?: string;
}

export interface DailyRecapOptions extends RecapOptions {
  date: string; // 'YYYY-MM-DD'
}

export interface WeeklyRecapOptions extends RecapOptions {
  weekIso: string; // 'YYYY-Wnn'
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
