import type { Program } from '../types/score.js';

/**
 * Recording mode for one movement, derived from the score-level session reuse
 * option:
 *
 * - `cumulative` — a re-visited movement reuses its prior in-concert session.
 *   Recordings keep each attempt's snapshot plus an aggregated `final-*` copy.
 * - `fresh` — every execution of the movement starts a brand-new session.
 *   Recordings keep independent per-attempt snapshots only.
 *
 * Note: this mode governs in-concert, in-memory session reuse — not whether
 * transcripts are written to disk. Transcripts are recorded in both modes.
 */
export type SessionMode = 'cumulative' | 'fresh';

export interface SessionModeResolution {
  mode: SessionMode;
  /** Whether the deprecated `persistSession` alias was present. */
  deprecatedUsed: boolean;
  /** Whether both `reuseSession` and `persistSession` were set (alias ignored). */
  bothSet: boolean;
}

/**
 * Resolve the effective session reuse setting from a score program.
 *
 * `reuseSession: false` → `fresh`; anything else → `cumulative` (the default).
 * The legacy `persistSession` alias from before the rename is still honored:
 * `reuseSession` wins when both are set (the alias is then redundant), and a
 * deprecated key with no `reuseSession` decides as it always did. Callers
 * should surface a deprecation warning when `deprecatedUsed` is true.
 */
export function resolveSessionMode(program: Program | undefined): SessionModeResolution {
  const reuse = program?.reuseSession;
  const legacy = program?.persistSession;

  if (reuse !== undefined) {
    return {
      mode: reuse ? 'cumulative' : 'fresh',
      deprecatedUsed: legacy !== undefined,
      bothSet: legacy !== undefined,
    };
  }
  if (legacy !== undefined) {
    return { mode: legacy ? 'cumulative' : 'fresh', deprecatedUsed: true, bothSet: false };
  }
  return { mode: 'cumulative', deprecatedUsed: false, bothSet: false };
}