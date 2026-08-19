import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScoreRegistry } from '@orchestron/core';

const SCORE_FILE_PATTERN = /\.score\.(ya?ml)$/i;

/**
 * Load the required-context keys of a score directly from the configured
 * scores directories. Used only by help output, so it must not construct the
 * full Orchestron stack (store, adapters, harness servers).
 *
 * Each score file is loaded under its own try/catch: a single invalid or
 * unreadable `.score.yaml` must not mask a valid score in the same directory.
 *
 * Returns `undefined` when the score cannot be found in any directory.
 */
function loadScoreRequiredContext(
  scoreId: string,
  scoresDirs: string[],
): string[] | undefined {
  const registry = new ScoreRegistry();
  for (const dir of scoresDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Unreadable or absent directory — try the next one.
      continue;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      let isFile: boolean;
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue;
      }
      if (!isFile || !SCORE_FILE_PATTERN.test(entry)) continue;
      try {
        registry.loadFrom(fullPath);
      } catch {
        // A malformed or invalid score file must not break help inspection.
      }
    }
  }
  try {
    return registry.get(scoreId).requiredContext ?? [];
  } catch {
    return undefined;
  }
}

/**
 * Render the "Required context" section appended to `orchestron start`
 * help output. With a score id, lists each required key in its
 * `--context.<key>=<value>` form; without one, points at the per-score help.
 */
export function renderRequiredContextHelp(
  scoreId: string | undefined,
  scoresDirs: string[],
): string {
  if (!scoreId || scoreId.startsWith('-')) {
    return "\nTo see a score's required context run: orchestron start <score-id> --help\n";
  }

  const required = loadScoreRequiredContext(scoreId, scoresDirs);
  if (required === undefined) {
    return `\nNote: score '${scoreId}' not found in the configured scores directories.\n`;
  }
  if (required.length === 0) {
    return '\nRequired context:\n  This score declares no required context.\n';
  }
  const rows = required.map((key) => `  --context.${key}=<value>`).join('\n');
  return `\nRequired context:\n${rows}\n`;
}
