import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSkillCatalog,
  MAX_SKILL_FILE_SIZE,
  MAX_TOTAL_SKILLS,
  parseSkillFrontmatter,
} from './index.js';
import type { SkillInfo } from '@your-bot/contracts';

describe('SkillCatalog', () => {
  const tempDirs: string[] = [];

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `your-bot-test-skills-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  describe('parseSkillFrontmatter', () => {
    it('parses unquoted, single-quoted, and double-quoted frontmatter', () => {
      const content = `---
name: my-skill
description: "A description with \\"quotes\\""
author: 'John O''Connor'
# comment here
tags: test
---
# Body Title
This is the skill content.`;

      const result = parseSkillFrontmatter(content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('my-skill');
        expect(result.data.description).toBe('A description with "quotes"');
        expect(result.data.body).toBe('# Body Title\nThis is the skill content.');
      }
    });

    it('handles UTF-8 BOM transparently', () => {
      const content = '\uFEFF---\nname: bom-skill\ndescription: with bom\n---\nBody here';
      const result = parseSkillFrontmatter(content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.name).toBe('bom-skill');
        expect(result.data.body).toBe('Body here');
      }
    });

    it('rejects content without opening delimiter', () => {
      const result = parseSkillFrontmatter('name: foo\ndescription: bar\n---\nbody');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('delimited by ---');
      }
    });

    it('rejects unclosed frontmatter', () => {
      const result = parseSkillFrontmatter('---\nname: foo\ndescription: bar\nno closing');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('missing closing ---');
      }
    });

    it('rejects missing name or description', () => {
      expect(parseSkillFrontmatter('---\ndescription: only desc\n---\nbody').ok).toBe(false);
      expect(parseSkillFrontmatter('---\nname: only name\n---\nbody').ok).toBe(false);
      expect(parseSkillFrontmatter('---\nname: ""\ndescription: desc\n---\nbody').ok).toBe(false);
    });

    it('rejects invalid frontmatter lines without colons', () => {
      const result = parseSkillFrontmatter('---\nname: foo\ninvalid line\ndescription: bar\n---\nbody');
      expect(result.ok).toBe(false);
    });
  });

  describe('valid skills', () => {
    it('discovers valid skills in globalDir and reads their body', async () => {
      const globalDir = await createTempDir('global');
      const skillDir = path.join(globalDir, 'weather-lookup');
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: Weather Lookup
description: Fetches real-time weather
---
## Instructions
Look up weather for the user.`,
        'utf8',
      );

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(1);
      const skill = skills[0];
      expect(skill.id).toBe('weather-lookup');
      expect(skill.name).toBe('Weather Lookup');
      expect(skill.description).toBe('Fetches real-time weather');
      expect(skill.source).toBe('global');
      expect(skill.error).toBeUndefined();
      expect(skill.folder).toBe(await fs.realpath(skillDir));

      const body = await catalog.read(skill);
      expect(body).toBe('## Instructions\nLook up weather for the user.');
    });

    it('discovers valid skills in workspace .your-bot/skills directory', async () => {
      const workspaceDir = await createTempDir('ws');
      const wsSkillsDir = path.join(workspaceDir, '.your-bot', 'skills');
      const skillDir = path.join(wsSkillsDir, 'code-review');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: Code Review
description: Reviews pull requests
---
Review instructions here`,
        'utf8',
      );

      const catalog = createSkillCatalog({});
      const skills = await catalog.list([workspaceDir]);

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('code-review');
      expect(skills[0].source).toBe('workspace');
      expect(skills[0].name).toBe('Code Review');
      expect(skills[0].description).toBe('Reviews pull requests');
      expect(skills[0].error).toBeUndefined();

      const body = await catalog.read(skills[0]);
      expect(body).toBe('Review instructions here');
    });
  });

  describe('bad ids', () => {
    it('marks skills with invalid folder names with an error string', async () => {
      const globalDir = await createTempDir('bad-ids');
      const badIds = [
        'UPPERCASE',
        '_leading_underscore',
        '-leading-hyphen',
        'has space',
        'has.dot',
        'a'.repeat(65), // > 64 chars
        'invalid$char',
      ];

      for (const id of badIds) {
        const folder = path.join(globalDir, id);
        await fs.mkdir(folder);
        await fs.writeFile(
          path.join(folder, 'SKILL.md'),
          `---
name: ${id}
description: desc
---
body`,
        );
      }

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills.length).toBe(badIds.length);
      for (const skill of skills) {
        expect(skill.error).toBeDefined();
        expect(skill.error).toMatch(/Invalid skill id/);
        // read should reject skills with error
        await expect(catalog.read(skill)).rejects.toThrow();
      }
    });
  });

  describe('bad / missing frontmatter', () => {
    it('reports missing SKILL.md as an error in skill', async () => {
      const globalDir = await createTempDir('missing-skillmd');
      const emptySkillFolder = path.join(globalDir, 'no-file-skill');
      await fs.mkdir(emptySkillFolder);

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('no-file-skill');
      expect(skills[0].error).toContain('Missing SKILL.md');
      await expect(catalog.read(skills[0])).rejects.toThrow();
    });

    it('reports malformed or missing frontmatter as an error in skill', async () => {
      const globalDir = await createTempDir('bad-fm');

      const skill1 = path.join(globalDir, 'no-fm-delim');
      await fs.mkdir(skill1);
      await fs.writeFile(path.join(skill1, 'SKILL.md'), 'Plain markdown without frontmatter');

      const skill2 = path.join(globalDir, 'missing-name');
      await fs.mkdir(skill2);
      await fs.writeFile(path.join(skill2, 'SKILL.md'), '---\ndescription: desc only\n---\nbody');

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(2);
      expect(skills[0].error).toBeDefined();
      expect(skills[1].error).toBeDefined();
    });
  });

  describe('oversized file', () => {
    it('rejects SKILL.md exceeding 64 KiB', async () => {
      const globalDir = await createTempDir('oversized');
      const skillDir = path.join(globalDir, 'large-skill');
      await fs.mkdir(skillDir);

      const largeContent =
        '---\nname: large-skill\ndescription: large\n---\n' + 'A'.repeat(MAX_SKILL_FILE_SIZE + 100);

      await fs.writeFile(path.join(skillDir, 'SKILL.md'), largeContent, 'utf8');

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('large-skill');
      expect(skills[0].error).toContain('exceeds maximum size');
      await expect(catalog.read(skills[0])).rejects.toThrow(/exceeds maximum size/);
    });
  });

  describe('symlinked folder and file rejected', () => {
    it('rejects symlinked skill folder', async () => {
      const realDir = await createTempDir('real-folder');
      await fs.writeFile(
        path.join(realDir, 'SKILL.md'),
        '---\nname: Real\ndescription: Real desc\n---\nbody',
      );

      const globalDir = await createTempDir('symlink-folder-test');
      const symlinkPath = path.join(globalDir, 'symlinked-skill');
      await fs.symlink(realDir, symlinkPath);

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('symlinked-skill');
      expect(skills[0].error).toContain('must not be a symlink');
      await expect(catalog.read(skills[0])).rejects.toThrow(/symlink/);
    });

    it('rejects symlinked SKILL.md file inside skill folder', async () => {
      const outsideDir = await createTempDir('outside');
      const realFile = path.join(outsideDir, 'REAL_SKILL.md');
      await fs.writeFile(realFile, '---\nname: Real File\ndescription: Desc\n---\nbody');

      const globalDir = await createTempDir('symlink-file-test');
      const skillDir = path.join(globalDir, 'file-symlinked-skill');
      await fs.mkdir(skillDir);
      await fs.symlink(realFile, path.join(skillDir, 'SKILL.md'));

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('file-symlinked-skill');
      expect(skills[0].error).toContain('SKILL.md must not be a symlink');
      await expect(catalog.read(skills[0])).rejects.toThrow(/symlink/);
    });

    it('read-time safety re-validation catches symlinks created after list()', async () => {
      const globalDir = await createTempDir('toctou');
      const skillDir = path.join(globalDir, 'valid-then-symlink');
      await fs.mkdir(skillDir);
      const skillMd = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(skillMd, '---\nname: Valid\ndescription: Desc\n---\nbody');

      const catalog = createSkillCatalog({ globalDir });
      const [skill] = await catalog.list([]);
      expect(skill.error).toBeUndefined();

      // Replace SKILL.md with a symlink before read
      const secretFile = path.join(globalDir, 'secret.txt');
      await fs.writeFile(secretFile, 'secret content');
      await fs.unlink(skillMd);
      await fs.symlink(secretFile, skillMd);

      await expect(catalog.read(skill)).rejects.toThrow(/symlink/);
    });
  });

  describe('cap at 200 skills', () => {
    it('caps total returned skills at 200', async () => {
      const globalDir = await createTempDir('cap-200');

      // Create 210 skill folders
      for (let i = 0; i < 210; i++) {
        const id = `skill-${String(i).padStart(3, '0')}`;
        const folder = path.join(globalDir, id);
        await fs.mkdir(folder);
        await fs.writeFile(
          path.join(folder, 'SKILL.md'),
          `---
name: Skill ${i}
description: Description ${i}
---
body ${i}`,
        );
      }

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([]);

      expect(skills).toHaveLength(MAX_TOTAL_SKILLS);
      expect(skills.length).toBe(200);
      expect(skills[0].id).toBe('skill-000');
      expect(skills[199].id).toBe('skill-199');
    });
  });

  describe('workspace + global merge and deterministic sort', () => {
    it('merges global and workspace skills sorted by source then id', async () => {
      const globalDir = await createTempDir('global-merge');
      const ws1 = await createTempDir('ws1');
      const ws2 = await createTempDir('ws2');

      // Global skills: b-global, a-global
      for (const id of ['b-global', 'a-global']) {
        const f = path.join(globalDir, id);
        await fs.mkdir(f);
        await fs.writeFile(
          path.join(f, 'SKILL.md'),
          `---
name: Global ${id}
description: desc
---
body`,
        );
      }

      // Workspace 1 skills: z-ws, c-ws
      const ws1Skills = path.join(ws1, '.your-bot', 'skills');
      for (const id of ['z-ws', 'c-ws']) {
        const f = path.join(ws1Skills, id);
        await fs.mkdir(f, { recursive: true });
        await fs.writeFile(
          path.join(f, 'SKILL.md'),
          `---
name: WS1 ${id}
description: desc
---
body`,
        );
      }

      // Workspace 2 skills: a-ws
      const ws2Skills = path.join(ws2, '.your-bot', 'skills');
      const f = path.join(ws2Skills, 'a-ws');
      await fs.mkdir(f, { recursive: true });
      await fs.writeFile(
        path.join(f, 'SKILL.md'),
        `---
name: WS2 a-ws
description: desc
---
body`,
      );

      const catalog = createSkillCatalog({ globalDir });
      const skills = await catalog.list([ws1, ws2]);

      expect(skills.map(s => `${s.source}:${s.id}`)).toEqual([
        'global:a-global',
        'global:b-global',
        'workspace:a-ws',
        'workspace:c-ws',
        'workspace:z-ws',
      ]);
    });

    it('returns empty when globalDir or workspace skills dirs do not exist', async () => {
      const catalog = createSkillCatalog({
        globalDir: '/tmp/nonexistent-global-skills-' + Date.now(),
      });
      const skills = await catalog.list(['/tmp/nonexistent-ws-' + Date.now()]);
      expect(skills).toEqual([]);
    });
  });
});
