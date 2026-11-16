import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillCatalog, SkillInfo } from '@your-bot/contracts';

export const MAX_SKILL_FILE_SIZE = 64 * 1024; // 64 KiB
export const MAX_TOTAL_SKILLS = 200;
export const SKILL_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SkillCatalogOptions {
  globalDir?: string;
}

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  body: string;
}

export type ParseFrontmatterResult =
  | { ok: true; data: ParsedSkillFrontmatter }
  | { ok: false; error: string };

/**
 * Dependency-free parser for the YAML frontmatter subset required by SKILL.md:
 * Delimited by `---` lines, containing at least `name` and `description`
 * as single-line string scalars (optionally quoted).
 */
export function parseSkillFrontmatter(content: string): ParseFrontmatterResult {
  // Strip UTF-8 BOM if present
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;

  // Split lines while preserving ability to slice the body
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { ok: false, error: 'SKILL.md must start with YAML frontmatter delimited by ---' };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { ok: false, error: 'SKILL.md frontmatter missing closing --- delimiter' };
  }

  const fmLines = lines.slice(1, closingIndex);
  const fields: Record<string, string> = {};

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      return { ok: false, error: `Invalid frontmatter line (expected key: value): "${trimmed}"` };
    }

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2)) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if ((val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1).replace(/''/g, "'");
    }

    fields[key] = val;
  }

  if (!fields.name || fields.name.trim() === '') {
    return { ok: false, error: 'Frontmatter missing required field: name' };
  }
  if (!fields.description || fields.description.trim() === '') {
    return { ok: false, error: 'Frontmatter missing required field: description' };
  }

  // Calculate body slice position right after closing delimiter line + newline
  let pos = 0;
  for (let i = 0; i <= closingIndex; i++) {
    const nextNewline = text.indexOf('\n', pos);
    if (nextNewline === -1) {
      pos = text.length;
      break;
    }
    pos = nextNewline + 1;
  }
  const body = text.slice(pos);

  return {
    ok: true,
    data: {
      name: fields.name.trim(),
      description: fields.description.trim(),
      body,
    },
  };
}

/**
 * Scan a single skills directory for skill folders.
 * Returns an array of SkillInfo objects (invalid skills include an error property).
 */
async function scanSkillsDir(skillsDir: string, source: 'global' | 'workspace'): Promise<SkillInfo[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
  } catch {
    // Missing or inaccessible skills dir is simply empty
    return [];
  }

  let canonicalSkillsDir: string;
  try {
    canonicalSkillsDir = await fs.promises.realpath(skillsDir);
  } catch {
    return [];
  }

  const results: SkillInfo[] = [];

  for (const entry of entries) {
    const id = entry.name;
    const folderPath = path.join(skillsDir, id);

    let folderLstat: fs.Stats;
    try {
      folderLstat = await fs.promises.lstat(folderPath);
    } catch (err: any) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: folderPath,
        error: `Cannot stat skill folder: ${err.message}`,
      });
      continue;
    }

    // Reject symlinked skill folders
    if (folderLstat.isSymbolicLink()) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: folderPath,
        error: 'Skill folder must not be a symlink',
      });
      continue;
    }

    // Only directories can be skill folders
    if (!folderLstat.isDirectory()) {
      continue;
    }

    // Validate ID regex
    if (!SKILL_ID_REGEX.test(id)) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: folderPath,
        error: `Invalid skill id "${id}": must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
      });
      continue;
    }

    // Folder must canonically lie inside its parent skills dir
    let canonicalFolder: string;
    try {
      canonicalFolder = await fs.promises.realpath(folderPath);
    } catch (err: any) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: folderPath,
        error: `Cannot resolve canonical skill folder: ${err.message}`,
      });
      continue;
    }

    if (path.dirname(canonicalFolder) !== canonicalSkillsDir) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: 'Skill folder must canonically lie inside its parent skills dir',
      });
      continue;
    }

    // Check SKILL.md
    const skillMdPath = path.join(folderPath, 'SKILL.md');
    let mdLstat: fs.Stats;
    try {
      mdLstat = await fs.promises.lstat(skillMdPath);
    } catch {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: 'Missing SKILL.md',
      });
      continue;
    }

    if (mdLstat.isSymbolicLink()) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: 'SKILL.md must not be a symlink',
      });
      continue;
    }

    if (!mdLstat.isFile()) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: 'SKILL.md is not a regular file',
      });
      continue;
    }

    if (mdLstat.size > MAX_SKILL_FILE_SIZE) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: `SKILL.md exceeds maximum size of ${MAX_SKILL_FILE_SIZE} bytes`,
      });
      continue;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(skillMdPath, 'utf8');
    } catch (err: any) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: `Failed to read SKILL.md: ${err.message}`,
      });
      continue;
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_FILE_SIZE) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: `SKILL.md exceeds maximum size of ${MAX_SKILL_FILE_SIZE} bytes`,
      });
      continue;
    }

    const parsed = parseSkillFrontmatter(content);
    if (!parsed.ok) {
      results.push({
        id,
        name: '',
        description: '',
        source,
        folder: canonicalFolder,
        error: parsed.error,
      });
      continue;
    }

    results.push({
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      source,
      folder: canonicalFolder,
    });
  }

  return results;
}

export class SkillCatalogImpl implements SkillCatalog {
  private readonly globalDir?: string;

  constructor(options?: SkillCatalogOptions) {
    this.globalDir = options?.globalDir;
  }

  async list(workspaces: string[] = []): Promise<SkillInfo[]> {
    const allSkills: SkillInfo[] = [];

    // Scan global directory
    if (this.globalDir) {
      const globalSkills = await scanSkillsDir(this.globalDir, 'global');
      allSkills.push(...globalSkills);
    }

    // Scan each canonical workspace: <ws>/.your-bot/skills/*/SKILL.md
    const seenWorkspaces = new Set<string>();
    for (const ws of workspaces) {
      if (!ws || seenWorkspaces.has(ws)) {
        continue;
      }
      seenWorkspaces.add(ws);

      const wsSkillsDir = path.join(ws, '.your-bot', 'skills');
      const wsSkills = await scanSkillsDir(wsSkillsDir, 'workspace');
      allSkills.push(...wsSkills);
    }

    // Deterministic sort: source ('global' then 'workspace'), then id, then folder
    allSkills.sort((a, b) => {
      if (a.source !== b.source) {
        return a.source === 'global' ? -1 : 1;
      }
      if (a.id !== b.id) {
        return a.id.localeCompare(b.id);
      }
      return a.folder.localeCompare(b.folder);
    });

    // Bound to at most MAX_TOTAL_SKILLS (200)
    return allSkills.slice(0, MAX_TOTAL_SKILLS);
  }

  async read(skill: SkillInfo): Promise<string> {
    if (skill.error) {
      throw new Error(`Cannot read invalid skill "${skill.id}": ${skill.error}`);
    }

    if (!SKILL_ID_REGEX.test(skill.id)) {
      throw new Error(`Invalid skill id "${skill.id}": must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
    }

    // Re-validate folder safety rules at read time
    const folderLstat = await fs.promises.lstat(skill.folder);
    if (folderLstat.isSymbolicLink()) {
      throw new Error('Skill folder must not be a symlink');
    }
    if (!folderLstat.isDirectory()) {
      throw new Error('Skill folder is not a directory');
    }

    const canonicalFolder = await fs.promises.realpath(skill.folder);
    if (canonicalFolder !== skill.folder) {
      throw new Error('Skill folder is not canonical');
    }

    // Re-validate SKILL.md safety rules at read time
    const skillMdPath = path.join(skill.folder, 'SKILL.md');
    const mdLstat = await fs.promises.lstat(skillMdPath);
    if (mdLstat.isSymbolicLink()) {
      throw new Error('SKILL.md must not be a symlink');
    }
    if (!mdLstat.isFile()) {
      throw new Error('SKILL.md is not a regular file');
    }
    if (mdLstat.size > MAX_SKILL_FILE_SIZE) {
      throw new Error(`SKILL.md exceeds maximum size of ${MAX_SKILL_FILE_SIZE} bytes`);
    }

    const content = await fs.promises.readFile(skillMdPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_FILE_SIZE) {
      throw new Error(`SKILL.md exceeds maximum size of ${MAX_SKILL_FILE_SIZE} bytes`);
    }

    const parsed = parseSkillFrontmatter(content);
    if (!parsed.ok) {
      throw new Error(`Invalid SKILL.md frontmatter: ${parsed.error}`);
    }

    return parsed.data.body;
  }
}

export function createSkillCatalog(options?: SkillCatalogOptions): SkillCatalog {
  return new SkillCatalogImpl(options);
}
