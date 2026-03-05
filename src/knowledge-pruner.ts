import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Pruning criteria (PRUNE-04 documentation):
 * A fact block is considered STALE if:
 *   1. AGE: The section header includes a date (## Facts from YYYY-MM-DD) and
 *      the date is older than PRUNE_STALE_AFTER_DAYS (default: 180 days).
 *   2. CONTRADICTION: A section's body contains the keyword
 *      "SUPERSEDES" or "DEPRECATED" (case-insensitive).
 *      (Simple heuristic — agents can add these markers manually.)
 *
 * Stale sections are extracted and written to:
 *   knowledge/_archive/YYYY-MM-DD-{category}.md
 * where YYYY-MM-DD is today's date.
 *
 * The source file is rewritten WITHOUT the stale sections (atomic write).
 * If ALL sections in a file are stale, the entire source file is moved to
 * _archive/ instead of being rewritten as empty.
 */

export interface PruneOptions {
  groupFolder: string;
  /** Override for GROUPS_DIR — used in tests to point at a temp directory. */
  groupsDir?: string;
}

export interface PruneResult {
  categoriesScanned: number;
  factsArchived: number;
  archivedFiles: string[]; // paths of _archive/ files created
}

interface Section {
  header: string;
  body: string;
}

const DATE_SECTION_RE = /^## Facts from (\d{4}-\d{2}-\d{2})$/;
const CONTRADICTION_RE = /\b(SUPERSEDES|DEPRECATED)\b/i;

/**
 * Parse markdown content into sections split by "## " headers.
 * The first block (before any "## " heading) is the title/front-matter block and
 * is represented with an empty header.
 */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentHeader = '';
  let currentBodyLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save current section
      sections.push({ header: currentHeader, body: currentBodyLines.join('\n') });
      currentHeader = line;
      currentBodyLines = [];
    } else {
      currentBodyLines.push(line);
    }
  }

  // Push last section
  sections.push({ header: currentHeader, body: currentBodyLines.join('\n') });

  return sections;
}

/**
 * Determines whether a given section is stale.
 * A section is stale if:
 *   a) Its header matches "## Facts from YYYY-MM-DD" AND the date is
 *      older than PRUNE_STALE_AFTER_DAYS.
 *   b) OR its body contains "SUPERSEDES" or "DEPRECATED" (case-insensitive).
 */
function isSectionStale(header: string, body: string, today: Date): boolean {
  // CONTRADICTION check: any section whose body contains the markers
  if (CONTRADICTION_RE.test(body)) {
    return true;
  }

  // AGE check: only for "## Facts from YYYY-MM-DD" sections
  const dateMatch = DATE_SECTION_RE.exec(header);
  if (dateMatch) {
    const staleAfterDays = parseInt(process.env.PRUNE_STALE_AFTER_DAYS || '180', 10);
    const sectionDate = new Date(`${dateMatch[1]}T00:00:00.000Z`);
    const ageMs = today.getTime() - sectionDate.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > staleAfterDays) {
      return true;
    }
  }

  return false;
}

/**
 * Reconstruct content from sections, preserving original format.
 */
function sectionsToContent(sections: Section[]): string {
  return sections
    .map((s) => (s.header ? `${s.header}\n${s.body}` : s.body))
    .join('');
}

/**
 * Prune knowledge base for a group: scan category files, archive stale sections.
 */
export async function pruneKnowledgeBase(opts: PruneOptions): Promise<PruneResult> {
  const { groupFolder, groupsDir = GROUPS_DIR } = opts;

  const knowledgeDir = path.join(groupsDir, groupFolder, 'knowledge');

  if (!fs.existsSync(knowledgeDir)) {
    return { categoriesScanned: 0, factsArchived: 0, archivedFiles: [] };
  }

  let categoryFiles: string[];
  try {
    categoryFiles = fs
      .readdirSync(knowledgeDir)
      .filter((f) => f.endsWith('.md') && f !== '_index.md' && !f.startsWith('_archive'));
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to read knowledge directory');
    return { categoriesScanned: 0, factsArchived: 0, archivedFiles: [] };
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const archiveDir = path.join(knowledgeDir, '_archive');

  let categoriesScanned = 0;
  let factsArchived = 0;
  const archivedFiles: string[] = [];

  for (const filename of categoryFiles) {
    const category = filename.replace(/\.md$/, '');
    const sourcePath = path.join(knowledgeDir, filename);

    let content: string;
    try {
      content = fs.readFileSync(sourcePath, 'utf-8');
    } catch (err) {
      logger.warn({ groupFolder, filename, err }, 'Failed to read knowledge file');
      continue;
    }

    const sections = parseSections(content);

    // Separate title block (empty header) from the rest
    const titleSection = sections[0]; // always present (may be empty body)
    const contentSections = sections.slice(1);

    if (contentSections.length === 0) {
      // No ## sections — nothing to prune
      categoriesScanned++;
      continue;
    }

    const staleSections: Section[] = [];
    const freshSections: Section[] = [];

    for (const section of contentSections) {
      if (isSectionStale(section.header, section.body, today)) {
        staleSections.push(section);
      } else {
        freshSections.push(section);
      }
    }

    categoriesScanned++;

    if (staleSections.length === 0) {
      // Nothing to archive
      continue;
    }

    // Ensure _archive/ exists
    fs.mkdirSync(archiveDir, { recursive: true });

    const archivePath = path.join(archiveDir, `${todayStr}-${category}.md`);

    if (freshSections.length === 0) {
      // All sections stale — move entire file to _archive/
      fs.renameSync(sourcePath, archivePath);
      logger.info({ groupFolder, filename, archivePath }, 'Moved entire knowledge file to archive');
    } else {
      // Partial: write stale sections to archive, rewrite source without them
      const archiveContent = staleSections
        .map((s) => `${s.header}\n${s.body}`)
        .join('');

      // Write archive file (atomic)
      const archiveTmp = `${archivePath}.tmp`;
      fs.writeFileSync(archiveTmp, archiveContent, 'utf-8');
      fs.renameSync(archiveTmp, archivePath);

      // Rewrite source without stale sections (atomic)
      const freshContent = sectionsToContent([titleSection, ...freshSections]);
      const sourceTmp = `${sourcePath}.tmp`;
      fs.writeFileSync(sourceTmp, freshContent, 'utf-8');
      fs.renameSync(sourceTmp, sourcePath);

      logger.info(
        { groupFolder, filename, staleSections: staleSections.length, archivePath },
        'Archived stale sections from knowledge file',
      );
    }

    factsArchived += staleSections.length;
    archivedFiles.push(archivePath);
  }

  logger.info(
    { groupFolder, categoriesScanned, factsArchived },
    'Knowledge base pruning complete',
  );

  return { categoriesScanned, factsArchived, archivedFiles };
}
