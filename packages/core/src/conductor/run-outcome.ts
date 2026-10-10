import type { MovementOutcomes, RunOutcome } from '../types/score.js';

/**
 * Map a process exit code to a transition outcome using a movement's
 * `outcomes` map.
 *
 * Resolution order:
 * 1. An explicit numeric key (`"1"`, `"3"`, ...) wins.
 * 2. The `default` key when present.
 * 3. Fallback: `0 → success`, every other code → `failure`.
 *
 * The map *is* the evaluation for a run movement; no harness session or
 * evaluator is involved.
 */
export function resolveRunOutcome(
  outcomes: MovementOutcomes | undefined,
  exitCode: number,
): RunOutcome {
  if (outcomes) {
    const explicit = outcomes[String(exitCode)];
    if (isRunOutcome(explicit)) return explicit;
    const fallback = outcomes.default;
    if (isRunOutcome(fallback)) return fallback;
  }
  return exitCode === 0 ? 'success' : 'failure';
}

function isRunOutcome(value: unknown): value is RunOutcome {
  return value === 'success' || value === 'failure' || value === 'rejection';
}
