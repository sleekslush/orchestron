import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Default directory name for movement skills, resolved relative to the concert working directory. */
export const DEFAULT_SKILLS_DIR_NAME = 'skills';

/** A skill loaded from disk: markdown instruction block plus frontmatter. */
export interface LoadedSkill {
  name: string;
  content: string;
}

/**
 * Resolve the directory movement skills are loaded from.
 *
 * Precedence matches the existing config convention (higher wins):
 *   1. explicit override (e.g. score `metadata.skillsDir`)
 *   2. `ORCHESTRON_SKILLS_DIR` env var
 *   3. config-file `skillsDir`
 *   4. default `<defaultDir>` (the `skills/` directory next to the score)
 */
export function resolveSkillsDir(options: {
  /** Highest-precedence override (e.g. a score's `metadata.skillsDir`). */
  override?: string;
  env?: Record<string, string | undefined>;
  /** Config-file `skillsDir`. */
  config?: string;
  /** Fallback directory, e.g. `<cwd>/skills`. */
  defaultDir: string;
}): string {
  const e = options.env ?? (process.env as Record<string, string | undefined>);
  return options.override ?? e.ORCHESTRON_SKILLS_DIR ?? options.config ?? options.defaultDir;
}

/**
 * Load all skills found under `dir`.
 *
 * Discovery conventions (both supported):
 *   - `<dir>/<name>/SKILL.md`  — skill root directory named after the skill
 *   - `<dir>/<name>.skill.md`  — single-file skill
 *
 * Missing directory yields an empty list (callers decide whether that is an
 * error — for a movement that declares skills it is).
 */
export function loadSkillsFromDir(dir: string): LoadedSkill[] {
  if (!existsSync(dir)) return [];

  const skills: LoadedSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) {
        skills.push({ name: entry, content: readFileSync(skillFile, 'utf-8') });
      }
    } else if (entry.toLowerCase().endsWith('.skill.md')) {
      skills.push({
        name: entry.slice(0, -'.skill.md'.length),
        content: readFileSync(full, 'utf-8'),
      });
    }
  }
  return skills;
}

/**
 * Load exactly the named skills from `dir`, failing loudly when any requested
 * skill cannot be resolved. A movement that declares a skill must not silently
 * run without it — that would hide a typo'd skill name.
 */
export function loadNamedSkills(dir: string, names: string[]): LoadedSkill[] {
  if (names.length === 0) return [];

  const available = new Map(loadSkillsFromDir(dir).map((s) => [s.name, s]));
  const missing = names.filter((n) => !available.has(n));
  if (missing.length > 0) {
    throw new Error(
      `Skill(s) not found in skills directory '${dir}': ${missing.join(', ')}. ` +
        `Each skill must be a directory with a SKILL.md (or a <name>.skill.md file) under '${dir}'.`,
    );
  }
  return names.map((n) => available.get(n)!);
}

/**
 * Format the loaded skills for injection into a movement's prompt.
 *
 * Skill content is treated strictly as data: every blessed-by-default XML
 * metacharacter is escaped, so delimiters/frontmatter inside a skill can never
 * break out of the injected block and inject instructions or tags of their own.
 */
export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills.map((s) => {
    const safeName = escapeXml(s.name);
    const safeContent = escapeXml(s.content);
    return `<skill name="${safeName}">\n${safeContent}\n</skill>`;
  });

  return '\n\n<skills>\n' + blocks.join('\n\n') + '\n</skills>';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
