import fs from 'fs';
import path from 'path';

export interface MemoryContext {
  tacit: string;
  knowledgeIndex: string;
  dailyRecaps: string;
  lastConversation: string;
  tokenEstimate: {
    tacit: number;
    knowledgeIndex: number;
    dailyRecaps: number;
    lastConversation: number;
    total: number;
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text: string, budget: number): string {
  const maxChars = budget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function loadTacit(groupFolder: string, budget: number): string {
  const tacitDir = path.join(groupFolder, 'tacit');
  if (!fs.existsSync(tacitDir)) return '';

  try {
    const files = fs.readdirSync(tacitDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    const parts: string[] = [];
    let remaining = budget;

    for (const file of files) {
      if (remaining <= 0) break;
      const filePath = path.join(tacitDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const truncated = truncateToTokenBudget(content, remaining);
      parts.push(truncated);
      remaining -= estimateTokens(truncated);
    }

    return parts.join('\n\n');
  } catch (err) {
    console.error(
      `[memory-loader] Failed to load tacit layer: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

function loadKnowledgeIndex(groupFolder: string, budget: number): string {
  const indexPath = path.join(groupFolder, 'knowledge', '_index.md');
  if (!fs.existsSync(indexPath)) return '';

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    return truncateToTokenBudget(content, budget);
  } catch (err) {
    console.error(
      `[memory-loader] Failed to load knowledge index: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

function loadDailyRecaps(groupFolder: string, budget: number): string {
  const dailyDir = path.join(groupFolder, 'daily');
  if (!fs.existsSync(dailyDir)) return '';

  try {
    // Collect all .md files across YYYY-MM subdirectories
    const allFiles: string[] = [];
    const months = fs.readdirSync(dailyDir).sort();
    for (const month of months) {
      const monthDir = path.join(dailyDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      const files = fs.readdirSync(monthDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(monthDir, f));
      allFiles.push(...files);
    }

    // Sort descending by filename (YYYY-MM-DD) to get newest first
    allFiles.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

    const parts: string[] = [];
    let remaining = budget;
    let loaded = 0;

    for (const filePath of allFiles) {
      if (loaded >= 3 || remaining <= 0) break;
      const date = path.basename(filePath, '.md');
      const content = fs.readFileSync(filePath, 'utf-8');
      const entry = `## ${date}\n\n${content}`;
      const truncated = truncateToTokenBudget(entry, remaining);
      parts.push(truncated);
      remaining -= estimateTokens(truncated);
      loaded++;
    }

    return parts.join('\n\n');
  } catch (err) {
    console.error(
      `[memory-loader] Failed to load daily recaps: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

function loadLastConversation(groupFolder: string, budget: number): string {
  const conversationsDir = path.join(groupFolder, 'conversations');
  if (!fs.existsSync(conversationsDir)) return '';

  try {
    const files = fs.readdirSync(conversationsDir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) return '';

    // Find most recent by mtime
    const withMtime = files.map((f) => {
      const filePath = path.join(conversationsDir, f);
      const stat = fs.statSync(filePath);
      return { filePath, mtime: stat.mtimeMs };
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const content = fs.readFileSync(withMtime[0].filePath, 'utf-8');
    return truncateToTokenBudget(content, budget);
  } catch (err) {
    console.error(
      `[memory-loader] Failed to load last conversation: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

export async function loadMemoryContext(
  groupFolder: string,
  totalBudget: number,
  layerAllocation: Record<string, number>,
): Promise<MemoryContext> {
  if (!fs.existsSync(groupFolder)) {
    console.error(`[memory-loader] Group folder not found: ${groupFolder} — returning empty memory`);
    return {
      tacit: '',
      knowledgeIndex: '',
      dailyRecaps: '',
      lastConversation: '',
      tokenEstimate: { tacit: 0, knowledgeIndex: 0, dailyRecaps: 0, lastConversation: 0, total: 0 },
    };
  }

  // Priority order: tacit → daily → conversation → knowledge
  // Each layer fills its allocated budget; unused tokens flow to next layer
  let budgetRemaining = totalBudget;

  const tacitBudget = Math.floor((layerAllocation['tacit'] ?? 0.15) * totalBudget);
  const tacit = loadTacit(groupFolder, tacitBudget);
  const tacitTokens = estimateTokens(tacit);
  budgetRemaining -= tacitTokens;

  const dailyBudget = Math.floor((layerAllocation['daily'] ?? 0.35) * totalBudget) + Math.max(0, tacitBudget - tacitTokens);
  const dailyRecaps = loadDailyRecaps(groupFolder, Math.min(dailyBudget, budgetRemaining));
  const dailyTokens = estimateTokens(dailyRecaps);
  budgetRemaining -= dailyTokens;

  const convBudget = Math.floor((layerAllocation['conversation'] ?? 0.3) * totalBudget) + Math.max(0, dailyBudget - dailyTokens);
  const lastConversation = loadLastConversation(groupFolder, Math.min(convBudget, budgetRemaining));
  const convTokens = estimateTokens(lastConversation);
  budgetRemaining -= convTokens;

  const knowledgeBudget = Math.floor((layerAllocation['knowledge'] ?? 0.2) * totalBudget) + Math.max(0, convBudget - convTokens);
  const knowledgeIndex = loadKnowledgeIndex(groupFolder, Math.min(knowledgeBudget, budgetRemaining));
  const knowledgeTokens = estimateTokens(knowledgeIndex);

  const total = tacitTokens + dailyTokens + convTokens + knowledgeTokens;

  return {
    tacit,
    knowledgeIndex,
    dailyRecaps,
    lastConversation,
    tokenEstimate: {
      tacit: tacitTokens,
      knowledgeIndex: knowledgeTokens,
      dailyRecaps: dailyTokens,
      lastConversation: convTokens,
      total,
    },
  };
}
