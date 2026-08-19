import { ScoreRegistry, loadScoresFromDir } from '@orchestron/core';

/**
 * Load the required-context keys of a score directly from the configured
 * scores directories. Used only by help output, so it must not construct the
 * full Orchestron stack (store, adapters, harness servers).
 *
 * Returns `undefined` when the score cannot be found in any directory.
 */
function loadScoreRequiredContext(
  scoreId: string,
  scoresDirs: string[],
): string[] | undefined {
  const registry = new ScoreRegistry();
  for (const dir of scoresDirs) {
    try {
      loadScoresFromDir(dir, registry);
    } catch {
      // An invalid or unreadable score in one directory must not break help
      // inspection; the next directory may still contain the score.
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