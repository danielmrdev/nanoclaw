import fs from 'fs';
import path from 'path';

export interface IntrospectResult {
  knowledgeCategories: string[];
  recentDailyNotes: string[];
  conversationDateRange: {
    oldest: string | null;
    newest: string | null;
    total: number;
  };
}

export async function introspectMemory(groupPath: string): Promise<IntrospectResult> {
  const knowledgeCategories = loadKnowledgeCategories(groupPath);
  const recentDailyNotes = loadRecentDailyNotes(groupPath);
  const conversationDateRange = loadConversationDateRange(groupPath);

  return { knowledgeCategories, recentDailyNotes, conversationDateRange };
}

function loadKnowledgeCategories(groupPath: string): string[] {
  const knowledgeDir = path.join(groupPath, 'knowledge');
  try {
    if (!fs.existsSync(knowledgeDir)) return [];
    return fs
      .readdirSync(knowledgeDir)
      .filter((f) => f.endsWith('.md') && f !== '_index.md')
      .sort();
  } catch {
    return [];
  }
}

function loadRecentDailyNotes(groupPath: string): string[] {
  const dailyDir = path.join(groupPath, 'daily');
  try {
    if (!fs.existsSync(dailyDir)) return [];

    const allDates: string[] = [];
    const monthPattern = /^\d{4}-\d{2}$/;

    for (const entry of fs.readdirSync(dailyDir)) {
      if (!monthPattern.test(entry)) continue;
      const monthDir = path.join(dailyDir, entry);
      try {
        if (!fs.statSync(monthDir).isDirectory()) continue;
        for (const file of fs.readdirSync(monthDir)) {
          if (file.endsWith('.md')) {
            allDates.push(file.replace(/\.md$/, ''));
          }
        }
      } catch {
        // skip unreadable month dirs
      }
    }

    return allDates.sort((a, b) => b.localeCompare(a)).slice(0, 7);
  } catch {
    return [];
  }
}

function loadConversationDateRange(groupPath: string): IntrospectResult['conversationDateRange'] {
  const conversationsDir = path.join(groupPath, 'conversations');
  try {
    if (!fs.existsSync(conversationsDir)) {
      return { oldest: null, newest: null, total: 0 };
    }

    const files = fs
      .readdirSync(conversationsDir)
      .filter((f) => f.endsWith('.md'));

    if (files.length === 0) {
      return { oldest: null, newest: null, total: 0 };
    }

    const withMtime = files.map((f) => {
      const filePath = path.join(conversationsDir, f);
      try {
        const stat = fs.statSync(filePath);
        return { mtime: stat.mtimeMs };
      } catch {
        return { mtime: 0 };
      }
    });

    withMtime.sort((a, b) => a.mtime - b.mtime);

    const toDateStr = (ms: number) => new Date(ms).toISOString().split('T')[0];
    const oldest = withMtime[0].mtime > 0 ? toDateStr(withMtime[0].mtime) : null;
    const newest = withMtime[withMtime.length - 1].mtime > 0 ? toDateStr(withMtime[withMtime.length - 1].mtime) : null;

    return { oldest, newest, total: files.length };
  } catch {
    return { oldest: null, newest: null, total: 0 };
  }
}

export function formatIntrospectReport(result: IntrospectResult): string {
  const { knowledgeCategories, recentDailyNotes, conversationDateRange } = result;
  const hasAnyData =
    knowledgeCategories.length > 0 ||
    recentDailyNotes.length > 0 ||
    conversationDateRange.total > 0;

  if (!hasAnyData) {
    return 'No memory data found for this group yet.';
  }

  const lines: string[] = ['## Memory Introspection Report', ''];

  lines.push(`**Knowledge Base** (${knowledgeCategories.length} categories):`);
  if (knowledgeCategories.length > 0) {
    for (const cat of knowledgeCategories) {
      lines.push(`- ${cat}`);
    }
  } else {
    lines.push('- (none)');
  }
  lines.push('');

  lines.push(`**Daily Notes** (last 7 available):`);
  if (recentDailyNotes.length > 0) {
    for (const date of recentDailyNotes) {
      lines.push(`- ${date}`);
    }
  } else {
    lines.push('- (none)');
  }
  lines.push('');

  const { oldest, newest, total } = conversationDateRange;
  if (total > 0 && oldest && newest) {
    lines.push(`**Conversations**: ${total} total, from ${oldest} to ${newest}`);
  } else {
    lines.push(`**Conversations**: ${total} total`);
  }

  return lines.join('\n');
}

export function searchMemory(groupPath: string, query: string): string {
  const matches: string[] = [];
  const queryLower = query.toLowerCase();

  // Search knowledge/_index.md
  const indexPath = path.join(groupPath, 'knowledge', '_index.md');
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (line.toLowerCase().includes(queryLower)) {
          matches.push(line);
          if (matches.length >= 20) return formatSearchResults(matches, query);
        }
      }
    }
  } catch {
    // ignore
  }

  // Search last 3 daily notes
  const dailyDir = path.join(groupPath, 'daily');
  try {
    if (fs.existsSync(dailyDir)) {
      const allFiles: Array<{ filePath: string; date: string }> = [];
      const monthPattern = /^\d{4}-\d{2}$/;

      for (const entry of fs.readdirSync(dailyDir)) {
        if (!monthPattern.test(entry)) continue;
        const monthDir = path.join(dailyDir, entry);
        try {
          if (!fs.statSync(monthDir).isDirectory()) continue;
          for (const file of fs.readdirSync(monthDir)) {
            if (file.endsWith('.md')) {
              allFiles.push({ filePath: path.join(monthDir, file), date: file.replace(/\.md$/, '') });
            }
          }
        } catch {
          // skip
        }
      }

      const recent = allFiles.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);

      for (const { filePath } of recent) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n')) {
            if (line.toLowerCase().includes(queryLower)) {
              matches.push(line);
              if (matches.length >= 20) return formatSearchResults(matches, query);
            }
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // ignore
  }

  return formatSearchResults(matches, query);
}

function formatSearchResults(matches: string[], query: string): string {
  if (matches.length === 0) {
    return `## Relevant Memory\n\nNo matches found for '${query}'.`;
  }
  const lines = ['## Relevant Memory', '', '```'];
  for (const m of matches.slice(0, 20)) {
    lines.push(m);
  }
  lines.push('```');
  return lines.join('\n');
}
