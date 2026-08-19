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
      ? { key: entry.trim() }
      : { key: entry.key.trim(), description: entry.description },
  );
}

/** Resolve a dot-path key (e.g. `ticket`, `project.name`) in a context object. */
export function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  let value: unknown = context;
  for (const part of path.split('.')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return value;
}

/**
 * Return the required-context keys whose dot-path value in `context` is
 * `undefined` or `null`. Falsy-but-present values (`false`, `0`, `''`) count
 * as present.
 */
export function findMissingRequiredContext(
  requiredContext: RequiredContext | undefined,
  context: Record<string, unknown>,
): string[] {
  return normalizeRequiredContext(requiredContext)
    .map((item) => item.key)
    .filter((key) => {
      const value = resolveContextPath(context, key);
      return value === undefined || value === null;
    });
}
