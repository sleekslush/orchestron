import type { RequiredContext } from './types/score.js';

/** A normalized required-context input: the dot-path key plus an optional
 *  description. The conductor derives enforcement keys and the CLI builds
 *  help output from this single source of truth, so both entry shapes
 *  (flat string vs `{ key, description }`) can never diverge. */
export interface RequiredContextItem {
  key: string;
  description?: string;
}

/**
 * Convert a score's `requiredContext` (an array of flat strings and/or
 * `{ key, description }` objects) into a uniform `{ key, description? }[]`.
 * Array ordering is preserved, so help output stays stable. Returns an empty
 * array when `requiredContext` is absent.
 */
export function normalizeRequiredContext(
  requiredContext: RequiredContext | undefined,
): RequiredContextItem[] {
  if (!requiredContext) return [];
  return requiredContext.map((entry) =>
    typeof entry === 'string'
      ? { key: entry }
      : { key: entry.key, description: entry.description },
  );
}
