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

/**
 * Context keys the runtime always injects into `context.shared` before a
 * concert's movements run. They are never supplied by the caller, so
 * required-context validation treats them as always satisfied. Without this,
 * a score requiring e.g. `concertId` would be rejected at the CLI preflight
 * before `ConcertHall.createConcert` has a chance to inject it.
 *
 * `buildInitialSharedContext` is the single place that writes these keys, and
 * `findMissingRequiredContext` is the single place that ignores them, so the
 * two can never drift.
 */
export const RUNTIME_CONTEXT_KEYS = ['concertId', 'scoreId'] as const;

export type RuntimeContextKey = (typeof RUNTIME_CONTEXT_KEYS)[number];
export type RuntimeContextValues = Record<RuntimeContextKey, string>;

/**
 * Build the shared context a concert starts with, merging caller-supplied
 * `initialContext` with the runtime-injected key set. Callers cannot override
 * the injected keys because they are spread last.
 */
export function buildInitialSharedContext(
  initialContext: Record<string, unknown> | undefined,
  runtime: RuntimeContextValues,
): Record<string, unknown> {
  return { ...initialContext, ...runtime };
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
 *
 * Runtime-injected keys ({@link RUNTIME_CONTEXT_KEYS}) are always considered
 * present, so the CLI preflight and the conductor agree even though only the
 * conductor's context has been through runtime injection yet.
 */
export function findMissingRequiredContext(
  requiredContext: RequiredContext | undefined,
  context: Record<string, unknown>,
): string[] {
  const runtimeKeys: ReadonlySet<string> = new Set(RUNTIME_CONTEXT_KEYS);
  return normalizeRequiredContext(requiredContext)
    .map((item) => item.key)
    .filter((key) => {
      if (runtimeKeys.has(key)) return false;
      const value = resolveContextPath(context, key);
      return value === undefined || value === null;
    });
}
