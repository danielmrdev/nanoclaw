import { CronExpressionParser } from 'cron-parser';

import { MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { createTask, getAllRegisteredGroups, getTasksForGroup } from './db.js';
import { logger } from './logger.js';

const DAILY_RECAP_CRON = process.env.DAILY_RECAP_CRON || '45 23 * * *';
const WEEKLY_RECAP_CRON = process.env.WEEKLY_RECAP_CRON || '0 0 * * 0';
const MONTHLY_RECAP_CRON = process.env.MONTHLY_RECAP_CRON || '0 0 1 * *';
const PRUNE_RECAP_CRON = process.env.PRUNE_RECAP_CRON || '30 0 1 * *';
const SEMESTER_RECAP_CRON = process.env.SEMESTER_RECAP_CRON || '0 0 1 1,7 *';
const ANNUAL_RECAP_CRON = process.env.ANNUAL_RECAP_CRON || '0 1 1 1 *';

// Deterministic task IDs so idempotency check is reliable
function dailyRecapTaskId(groupFolder: string): string {
  return `recap-daily-${groupFolder}`;
}

function weeklyRecapTaskId(groupFolder: string): string {
  return `recap-weekly-${groupFolder}`;
}

function monthlyRecapTaskId(groupFolder: string): string {
  return `recap-monthly-${groupFolder}`;
}

function semesterRecapTaskId(groupFolder: string): string {
  return `recap-semester-${groupFolder}`;
}

function annualRecapTaskId(groupFolder: string): string {
  return `recap-annual-${groupFolder}`;
}

function pruneTaskId(groupFolder: string): string {
  return `recap-prune-${groupFolder}`;
}

function nextCronRun(cronExpr: string): string | null {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toISOString();
}

/**
 * Idempotently registers daily and weekly recap tasks for all active registered groups.
 * Safe to call on every process start — existing tasks are left untouched.
 * Main group is skipped (isMain isolation boundary).
 */
export function ensureRecapTasks(): void {
  const groups = getAllRegisteredGroups();
  const now = new Date().toISOString();

  for (const [jid, group] of Object.entries(groups)) {
    // All groups get recaps, including main

    const existingTasks = getTasksForGroup(group.folder);
    const existingIds = new Set(existingTasks.map((t) => t.id));

    // --- Daily recap ---
    const dailyId = dailyRecapTaskId(group.folder);
    if (!existingIds.has(dailyId)) {
      createTask({
        id: dailyId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildDailyRecapPrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: DAILY_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(DAILY_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: dailyId },
        'Registered daily recap task',
      );
    }

    // --- Weekly recap ---
    const weeklyId = weeklyRecapTaskId(group.folder);
    if (!existingIds.has(weeklyId)) {
      createTask({
        id: weeklyId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildWeeklyRecapPrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: WEEKLY_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(WEEKLY_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: weeklyId },
        'Registered weekly recap task',
      );
    }

    // --- Monthly recap ---
    const monthlyId = monthlyRecapTaskId(group.folder);
    if (!existingIds.has(monthlyId)) {
      createTask({
        id: monthlyId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildMonthlyRecapPrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: MONTHLY_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(MONTHLY_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: monthlyId },
        'Registered monthly recap task',
      );
    }

    // --- Knowledge base pruning ---
    const pruneId = pruneTaskId(group.folder);
    if (!existingIds.has(pruneId)) {
      createTask({
        id: pruneId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildPrunePrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: PRUNE_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(PRUNE_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: pruneId },
        'Registered knowledge pruning task',
      );
    }

    // --- Semester recap ---
    const semesterId = semesterRecapTaskId(group.folder);
    if (!existingIds.has(semesterId)) {
      createTask({
        id: semesterId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildSemesterRecapPrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: SEMESTER_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(SEMESTER_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: semesterId },
        'Registered semester recap task',
      );
    }

    // --- Annual recap ---
    const annualId = annualRecapTaskId(group.folder);
    if (!existingIds.has(annualId)) {
      createTask({
        id: annualId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt: buildAnnualRecapPrompt(group.folder),
        schedule_type: 'cron',
        schedule_value: ANNUAL_RECAP_CRON,
        context_mode: 'isolated',
        next_run: nextCronRun(ANNUAL_RECAP_CRON),
        status: 'active',
        created_at: now,
      });
      logger.info(
        { groupFolder: group.folder, taskId: annualId },
        'Registered annual recap task',
      );
    }
  }
}

function buildDailyRecapPrompt(_groupFolder: string): string {
  return '[host-side: daily recap]';
}

function buildWeeklyRecapPrompt(groupFolder: string): string {
  return `You are running as an isolated recap agent for group "${groupFolder}".

Your job: Generate a weekly memory recap.

Instructions:
1. Read the last 7 daily recap files from groups/${groupFolder}/daily/YYYY-MM/*.md
   (read today's directory and the previous month's directory if week spans months).
2. Synthesize the week's daily notes into a structured weekly summary.
3. Write the weekly recap to: groups/${groupFolder}/daily/weekly/YYYY-Wnn.md
   (use ISO week number, e.g. daily/weekly/2026-W10.md)
4. Use atomic write: write to .tmp first, then rename.
5. Do NOT attempt to update any database — this task runs in an isolated container without SQLite access.

Weekly recap format:
\`\`\`markdown
# Weekly Recap — YYYY-Wnn (Mon DD – Sun DD)

## Week Overview
[3-5 sentence narrative of the week]

## Recurring Themes
- [theme]: [pattern observed across days]

## Key Decisions
- [decision]: [context and outcome]

## Durable Knowledge
- [fact or insight worth keeping long-term]

## Next Week Context
[Anything that should carry forward]
\`\`\`

If fewer than 3 daily notes exist for this week, synthesize from whatever is available.
If no daily notes exist, write: "# Weekly Recap — YYYY-Wnn\\n\\nNo daily notes available for this week."

Do NOT send any message to the chat. This task runs silently.`;
}

function buildMonthlyRecapPrompt(groupFolder: string): string {
  return `You are running as an isolated recap agent for group "${groupFolder}".

Your job: Generate a monthly memory recap by synthesizing the weekly notes for the current month.

Instructions:
1. Determine the current month in ISO format: YYYY-MM (e.g. "2026-03" for March 2026).
2. Read the weekly note files for this month from /workspace/group/daily/weekly/YYYY-Wnn.md.
   Determine which weeks belong to this month by checking whether the Monday of each ISO week falls within the month boundaries (first day of month, inclusive — first day of next month, exclusive).
3. Synthesize the weekly notes into a monthly recap.
4. Write the recap to: /workspace/group/daily/monthly/YYYY-MM.md
   (e.g. /workspace/group/daily/monthly/2026-03.md)
5. Use atomic write: write to /workspace/group/daily/monthly/YYYY-MM.md.tmp first, then rename.
6. Handle errors gracefully — log and continue if any step throws. Do not propagate errors.

Recap format:
\`\`\`markdown
# Monthly Recap — YYYY-MM

## Overview
[3-5 sentence narrative of the month]

## Recurring Themes
- [theme]: [pattern observed across weeks]

## Key Decisions
- [decision]: [context and outcome]

## Durable Knowledge
- [fact or insight worth keeping long-term]
\`\`\`

If no weekly notes exist for this month, write: "# Monthly Recap — YYYY-MM\\n\\nNo weekly notes available."

Do NOT send any message to the chat. This task runs silently.`;
}

function buildSemesterRecapPrompt(groupFolder: string): string {
  return `You are running as an isolated recap agent for group "${groupFolder}".

Your job: Generate a semester memory recap by synthesizing the monthly notes for the current semester.

Instructions:
1. Determine the current semester based on today's month:
   - January–June → "YYYY-S1" (e.g. "2026-S1")
   - July–December → "YYYY-S2" (e.g. "2026-S2")
2. Read the 6 monthly note files for this semester from /workspace/group/daily/monthly/YYYY-MM.md.
   S1: months 01–06, S2: months 07–12. Skip months that have no file.
3. Synthesize the monthly notes into a semester recap.
4. Write the recap to: /workspace/group/daily/semester/YYYY-Sn.md
   (e.g. /workspace/group/daily/semester/2026-S1.md)
5. Use atomic write: write to /workspace/group/daily/semester/YYYY-Sn.md.tmp first, then rename.
6. Handle errors gracefully — log and continue if any step throws. Do not propagate errors.

Recap format:
\`\`\`markdown
# Semester Recap — YYYY-Sn

## Overview
[3-5 sentence narrative of the semester]

## Recurring Themes
- [theme]: [pattern observed across months]

## Key Decisions
- [decision]: [context and outcome]

## Durable Knowledge
- [fact or insight worth keeping long-term]
\`\`\`

If no monthly notes exist for this semester, write: "# Semester Recap — YYYY-Sn\\n\\nNo monthly notes available."

Do NOT send any message to the chat. This task runs silently.`;
}

function buildAnnualRecapPrompt(groupFolder: string): string {
  return `You are running as an isolated recap agent for group "${groupFolder}".

Your job: Generate an annual memory recap by synthesizing the semester notes for the current year.

Instructions:
1. Determine the current year (e.g. 2026).
2. Read the semester note files from:
   - /workspace/group/daily/semester/YYYY-S1.md
   - /workspace/group/daily/semester/YYYY-S2.md
   Skip any file that does not exist.
3. Synthesize the semester notes into an annual recap.
4. Write the recap to: /workspace/group/daily/annual/YYYY.md
   (e.g. /workspace/group/daily/annual/2026.md)
5. Use atomic write: write to /workspace/group/daily/annual/YYYY.md.tmp first, then rename.
6. Handle errors gracefully — log and continue if any step throws. Do not propagate errors.

Recap format:
\`\`\`markdown
# Annual Recap — YYYY

## Overview
[3-5 sentence narrative of the year]

## Recurring Themes
- [theme]: [pattern observed across semesters]

## Key Decisions
- [decision]: [context and outcome]

## Durable Knowledge
- [fact or insight worth keeping long-term]
\`\`\`

If no semester notes exist for this year, write: "# Annual Recap — YYYY\\n\\nNo semester notes available."

Do NOT send any message to the chat. This task runs silently.`;
}

function buildPrunePrompt(groupFolder: string): string {
  return `You are running as an isolated pruning agent for group "${groupFolder}".

Your job: Prune the knowledge base by archiving stale or contradicted facts.

Instructions:
1. Import pruneKnowledgeBase from src/knowledge-pruner.ts.
   Call it: pruneKnowledgeBase({ groupFolder: "${groupFolder}" })
2. Log the result:
   "Knowledge pruning complete: scanned {result.categoriesScanned} categories, archived {result.factsArchived} fact sections"
3. Handle errors gracefully — log the error and continue. Do not propagate the error.

Do NOT send any message to the chat. This task runs silently.`;
}
