import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneKnowledgeBase } from './knowledge-pruner.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
}

function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

/** Returns a date string that is `daysAgo` days in the past from today. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('pruneKnowledgeBase', () => {
  let groupsDir: string;
  let groupFolder: string;

  beforeEach(() => {
    groupsDir = makeTmpDir();
    groupFolder = 'test-group';
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    fs.rmSync(groupsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('returns zero result when knowledge/ directory does not exist', async () => {
    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });
    expect(result).toEqual({ categoriesScanned: 0, factsArchived: 0, archivedFiles: [] });
  });

  it('returns categoriesScanned=1 and factsArchived=0 when no stale sections', async () => {
    const recentDate = daysAgo(10); // 10 days old — well within default 180
    const content = [
      '# Preferences',
      '',
      `## Facts from ${recentDate}`,
      '',
      '- Likes dark mode',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });
    expect(result.categoriesScanned).toBe(1);
    expect(result.factsArchived).toBe(0);
    expect(result.archivedFiles).toHaveLength(0);
  });

  it('archives a section older than 180 days and rewrites the source file', async () => {
    const staleDate = daysAgo(200);
    const freshDate = daysAgo(5);
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Old preference',
      '',
      `## Facts from ${freshDate}`,
      '',
      '- Current preference',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.categoriesScanned).toBe(1);
    expect(result.factsArchived).toBe(1);
    expect(result.archivedFiles).toHaveLength(1);

    // Source file should no longer contain the stale section
    const remaining = fs.readFileSync(
      path.join(groupsDir, groupFolder, 'knowledge', 'preferences.md'),
      'utf-8',
    );
    expect(remaining).not.toContain(staleDate);
    expect(remaining).toContain(freshDate);

    // Archive file should exist
    const archivePath = result.archivedFiles[0];
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(archivePath).toContain('_archive');
    expect(archivePath).toContain('preferences');
  });

  it('archives a section containing "DEPRECATED"', async () => {
    const content = [
      '# Projects',
      '',
      '## Active projects',
      '',
      '- DEPRECATED: old project no longer active',
      '',
      '## Current projects',
      '',
      '- New project',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/projects.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.factsArchived).toBe(1);
    const remaining = fs.readFileSync(
      path.join(groupsDir, groupFolder, 'knowledge', 'projects.md'),
      'utf-8',
    );
    expect(remaining).not.toContain('DEPRECATED');
    expect(remaining).toContain('New project');
  });

  it('archives a section containing "SUPERSEDES"', async () => {
    const content = [
      '# Projects',
      '',
      '## Old context',
      '',
      '- Some fact here',
      '',
      '## New context',
      '',
      '- SUPERSEDES the old context',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/projects.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.factsArchived).toBeGreaterThanOrEqual(1);
  });

  it('moves the entire file to _archive/ when all sections are stale', async () => {
    const staleDate1 = daysAgo(200);
    const staleDate2 = daysAgo(250);
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate1}`,
      '',
      '- Old preference A',
      '',
      `## Facts from ${staleDate2}`,
      '',
      '- Old preference B',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.factsArchived).toBe(2);
    expect(result.archivedFiles).toHaveLength(1);

    // Source file should no longer exist at original location
    const sourcePath = path.join(groupsDir, groupFolder, 'knowledge', 'preferences.md');
    expect(fs.existsSync(sourcePath)).toBe(false);

    // Archive file must exist
    expect(fs.existsSync(result.archivedFiles[0])).toBe(true);
  });

  it('skips _index.md', async () => {
    const staleDate = daysAgo(200);
    const indexContent = [
      '# Knowledge Index',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Something very old',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/_index.md', indexContent);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    // _index.md excluded — nothing scanned
    expect(result.categoriesScanned).toBe(0);
    expect(result.factsArchived).toBe(0);
  });

  it('creates _archive/ directory if it does not exist', async () => {
    const staleDate = daysAgo(200);
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Old preference',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const archiveDir = path.join(groupsDir, groupFolder, 'knowledge', '_archive');
    expect(fs.existsSync(archiveDir)).toBe(false);

    await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it('uses atomic write for rewritten source files', async () => {
    const staleDate = daysAgo(200);
    const freshDate = daysAgo(5);
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Old',
      '',
      `## Facts from ${freshDate}`,
      '',
      '- New',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    await pruneKnowledgeBase({ groupFolder, groupsDir });

    // No .tmp file should remain
    const tmpFile = path.join(groupsDir, groupFolder, 'knowledge', 'preferences.md.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('archives all dated sections when PRUNE_STALE_AFTER_DAYS=0', async () => {
    vi.stubEnv('PRUNE_STALE_AFTER_DAYS', '0');

    const recentDate = daysAgo(1); // Only 1 day old, but threshold is 0
    const content = [
      '# Preferences',
      '',
      `## Facts from ${recentDate}`,
      '',
      '- Should be archived due to threshold=0',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.factsArchived).toBe(1);
  });

  it('archives no dated sections when PRUNE_STALE_AFTER_DAYS=99999', async () => {
    vi.stubEnv('PRUNE_STALE_AFTER_DAYS', '99999');

    const staleDate = daysAgo(500); // Very old, but threshold is huge
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Should NOT be archived due to huge threshold',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.factsArchived).toBe(0);
  });

  it('archivedFiles contains the correct _archive/ path', async () => {
    const staleDate = daysAgo(200);
    const content = [
      '# Preferences',
      '',
      `## Facts from ${staleDate}`,
      '',
      '- Old preference',
      '',
    ].join('\n');

    writeFile(path.join(groupsDir, groupFolder), 'knowledge/preferences.md', content);

    const result = await pruneKnowledgeBase({ groupFolder, groupsDir });

    expect(result.archivedFiles).toHaveLength(1);
    const archivePath = result.archivedFiles[0];

    // Must be inside _archive/
    expect(archivePath).toContain(path.join('knowledge', '_archive'));
    // Must reference the category name
    expect(archivePath).toContain('preferences');
    // Must end with .md
    expect(archivePath).toMatch(/\.md$/);
    // Must start with today's date (YYYY-MM-DD format in filename)
    const today = new Date().toISOString().slice(0, 10);
    expect(path.basename(archivePath)).toMatch(new RegExp(`^${today}-`));
  });
});
