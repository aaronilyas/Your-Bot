# @your-bot/skills

`@your-bot/skills` implements the v2 `SkillCatalog` interface, providing discovery, validation, and content retrieval for agent skills from both global installations and per-workspace directories.

## Capabilities

- **Catalog Discovery**: Scans global skills (`<globalDir>/*/SKILL.md`, source: `'global'`) and workspace-local skills (`<workspace>/.your-bot/skills/*/SKILL.md`, source: `'workspace'`).
- **YAML Frontmatter Parser**: Tiny, zero-dependency parser for YAML frontmatter delimited by `---` lines, extracting `name` and `description` string scalars (with support for unquoted, single-quoted, and double-quoted strings, plus comments).
- **Safety & Confinement**:
  - Validates folder ID format: `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
  - Rejects symlinked skill folders and symlinked `SKILL.md` files (`lstat`).
  - Enforces canonical containment: skill folders must canonically lie inside their parent skills directory (`realpath`).
  - Size bounded: `SKILL.md` files must not exceed 64 KiB (`MAX_SKILL_FILE_SIZE = 65,536 bytes`).
  - Catalog bounded: at most 200 skills returned total (`MAX_TOTAL_SKILLS = 200`).
  - Missing directories are treated as empty without throwing.
  - Non-fatal validation: invalid skills are included in `list()` with an `error` property instead of throwing.
  - Deterministic sort: results are ordered by source (`'global'` before `'workspace'`), then folder `id`, then `folder`.
  - Read-time safety re-validation: `read(skill)` re-checks canonical confinement, symlinks, size bounds, and frontmatter format at read time.

## Usage

```typescript
import { createSkillCatalog } from '@your-bot/skills';

const catalog = createSkillCatalog({
  globalDir: '/home/user/.your-bot/skills',
});

// List skills across global dir and bot workspaces
const skills = await catalog.list([
  '/home/user/projects/workspace-a',
]);

for (const skill of skills) {
  if (skill.error) {
    console.warn(`Skill ${skill.id} failed validation: ${skill.error}`);
    continue;
  }
  console.log(`Available skill: ${skill.name} (${skill.id})`);
}

// Read skill body (frontmatter removed)
const skillContent = await catalog.read(skills[0]);
```
