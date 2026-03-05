import { CronExpressionParser } from 'cron-parser';

import { MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { createTask, getAllRegisteredGroups, getTasksForGroup } from './db.js';
import { logger } from './logger.js';

const DAILY_RECAP_CRON = process.env.DAILY_RECAP_CRON || '45 23 * * *';
const WEEKLY_RECAP_CRON = process.env.WEEKLY_RECAP_CRON || '0 0 * * 0';

// Deterministic task IDs so idempotency check is reliable
function dailyRecapTaskId(groupFolder: string): string {
  return `recap-daily-${groupFolder}`;
}

function weeklyRecapTaskId(groupFolder: string): string {
  return `recap-weekly-${groupFolder}`;
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
    if (group.folder === MAIN_GROUP_FOLDER) continue;

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
  }
}

function buildDailyRecapPrompt(groupFolder: string): string {
  return `You are running as an isolated recap agent for group "${groupFolder}".

Your job: Generate a daily memory recap for today.

Instructions:
1. Read all conversation messages from SQLite for today (the past 24 hours).
   Use the getMessagesSince() function or read from the IPC/filesystem — use whatever is available in your context.
2. Synthesize the day's conversations into a structured Markdown recap.
3. Write the recap to: groups/${groupFolder}/daily/YYYY-MM/YYYY-MM-DD.md
   (use today's actual date for the path, e.g. daily/2026-03/2026-03-05.md)
4. Use atomic write: write to the .tmp file first, then rename.
5. After writing the recap, update the last_recap_timestamp in SQLite for this group's daily cadence.
6. Run conversation archival: move conversation files older than 30 days to conversations/archive/YYYY-MM/.

Recap format:
\`\`\`markdown
# Daily Recap — YYYY-MM-DD

## Summary
[2-3 sentence overview of the day]

## Key Topics
- [topic]: [brief description]

## Decisions & Actions
- [decision or action taken]

## Facts to Remember
- [durable fact worth persisting]

## Open Questions
- [anything unresolved]
\`\`\`

If there are no messages today, write: "# Daily Recap — YYYY-MM-DD\\n\\nNo conversations today."

Do NOT send any message to the chat. This task runs silently.`;
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
5. After writing, update last_recap_timestamp in SQLite for this group's weekly cadence.

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
