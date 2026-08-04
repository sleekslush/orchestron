import { computeLiveness } from './liveness.js';
import type { ConcertStore } from './store/concert-store.js';
import type { Concert, ConcertID } from './types/concert.js';
import type { ConcertEvent } from './types/events.js';

/**
 * Failure reason stamped on a concert that was auto-finalized because its
 * hosting process died without transitioning the stored status itself.
 */
export const FINALIZE_STALE_REASON = 'process_died';

/**
 * Statuses a dead process may leave behind and that external finalization may
 * clean up. Terminal concerts and `pending` concerts (whose process never
 * started / heartbeated) are never finalized here: `pending` is not a hosting
 * status and a stale pending row is not a zombie — it simply was never started.
 */
const FINALIZABLE_STATUSES = new Set(['running', 'paused']);

export interface FinalizeStaleOptions {
  /**
   * Persist a terminal `concert:failed` event when a concert is finalized, so
   * the transition is observable through the same event stream the conductor
   * would have emitted. Receives the full event (including its `concertId`).
   */
  recordEvent?: (event: ConcertEvent) => Promise<void> | void;
}

export interface FinalizeStaleResult {
  concertId: ConcertID;
  /** Whether the concert was actually transitioned to `failed`. */
  finalized: boolean;
  /** Liveness reason when the concert was finalized (pid_dead / heartbeat_stale). */
  reason?: string;
}

/**
 * Externally finalize a single stale concert, transitioning it to `failed`
 * with reason {@link FINALIZE_STALE_REASON}.
 *
 * Race-safe by design (mirrors the conductor's own finalize guard):
 *   1. Re-reads the persisted row before acting, so it never clobbers a
 *      caller's stale in-memory copy.
 *   2. Only transitions statuses that are still liveness-relevant
 *      (`running`/`paused`) and still flagged stale by {@link computeLiveness}
 *      (dead PID or heartbeat beyond the grace period).
 *   3. Re-reads the stored status once more immediately before the flip, so a
 *      concurrently-completing conductor that transitions the row between the
 *      checks is never overwritten.
 */
export async function finalizeStaleConcert(
  store: ConcertStore,
  concertId: ConcertID,
  options: FinalizeStaleOptions = {},
): Promise<FinalizeStaleResult> {
  // Re-read from the store so we operate on persisted truth, not a caller's
  // potentially stale in-memory copy.
  const stored = await store.getConcert(concertId);
  if (!stored) return { concertId, finalized: false };

  if (!FINALIZABLE_STATUSES.has(stored.status)) {
    return { concertId, finalized: false };
  }

  const liveness = computeLiveness(stored);
  if (!liveness.stale) {
    return { concertId, finalized: false };
  }

  // Second re-read immediately before the flip closes the race with a
  // concurrently-completing conductor.
  const latest = await store.getConcert(concertId);
  if (!latest || !FINALIZABLE_STATUSES.has(latest.status)) {
    return { concertId, finalized: false };
  }

  await store.updateConcert({
    id: latest.id,
    status: 'failed',
    completedAt: new Date(),
  });

  await options.recordEvent?.({
    type: 'concert:failed',
    concertId: latest.id,
    error: {
      code: FINALIZE_STALE_REASON,
      message: `Concert ${latest.id} finalized as failed: hosting process died (${liveness.reason ?? 'unknown'})`,
      retryable: false,
      concertId: latest.id,
    },
    timestamp: new Date(),
  });

  return { concertId: latest.id, finalized: true, reason: liveness.reason };
}

/**
 * Finalize every stale concert currently in the store. Returns the results
 * for the concerts that were actually transitioned (``finalized: true``), so
 * callers (e.g. the CLI `finalize-stale` command or a future supervisor) can
 * report what was cleaned up.
 */
export async function finalizeAllStale(
  store: ConcertStore,
  options: FinalizeStaleOptions = {},
): Promise<FinalizeStaleResult[]> {
  const all = await store.listConcerts();
  const results: FinalizeStaleResult[] = [];
  for (const concert of all) {
    const result = await finalizeStaleConcert(store, concert.id, options);
    if (result.finalized) results.push(result);
  }
  return results;
}

/**
 * Re-export for callers that want to decide which concerts are finalizable.
 * Kept as a function so the CLI/status surface can share the exact same notion
 * of "can this stale concert be finalized" without duplicating the status set.
 */
export function isFinalizableStatus(status: Concert['status']): boolean {
  return FINALIZABLE_STATUSES.has(status);
}
