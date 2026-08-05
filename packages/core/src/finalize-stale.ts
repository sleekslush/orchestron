import { computeLiveness, computePendingLiveness } from './liveness.js';
import type { ConcertStore } from './store/concert-store.js';
import type { Concert, ConcertID } from './types/concert.js';
import type { ConcertEvent } from './types/events.js';
import type { LivenessInfo } from './liveness.js';

/**
 * Failure reason stamped on a concert that was auto-finalized because its
 * hosting process died without transitioning the stored status itself.
 */
export const FINALIZE_STALE_REASON = 'process_died';

/**
 * Statuses a dead process may leave behind and that external finalization may
 * clean up. Terminal concerts are never finalized here. `pending` is handled
 * separately (it is not a hosting status, but a stale pending row whose process
 * died before its first heartbeat is still a dead, untracked row worth cleaning
 * — see {@link computePendingLiveness} for the "never started" vs "died before
 * start" boundary).
 */
const FINALIZABLE_STATUSES = new Set(['running', 'paused']);

/** True for the statuses {@link finalizeStaleConcert} may act on. */
function isFinalizable(concert: Concert): boolean {
  return isFinalizableStatus(concert.status) || concert.status === 'pending';
}

/**
 * Staleness for whatever status a concert is in: `pending` rows use the
 * creation-vs-start boundary ({@link computePendingLiveness}); the hosting
 * statuses use heartbeat/PID liveness; terminal statuses are never stale.
 */
function computeStaleLiveness(concert: Concert): LivenessInfo {
  if (concert.status === 'pending') {
    return computePendingLiveness(concert);
  }
  return computeLiveness(concert);
}

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

  if (!isFinalizable(stored)) {
    return { concertId, finalized: false };
  }

  const liveness = computeStaleLiveness(stored);
  if (!liveness.stale) {
    return { concertId, finalized: false };
  }

  // Second re-read immediately before the flip closes the race with a
  // concurrently-completing conductor. Applied to pending rows exactly as to
  // running/paused ones, so a pending row that transitions between the two
  // reads (e.g. a real conductor finally starts it) is never clobbered.
  const latest = await store.getConcert(concertId);
  if (!latest || !isFinalizable(latest)) {
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
 * Whether a status is a hosting status a dead process may leave behind that
 * external finalization may act on. Note this excludes `pending`: a `pending`
 * row is never finalizable purely by status — its "died before start" staleness
 * additionally depends on age/process liveness, so it is gated inside
 * {@link finalizeStaleConcert} via {@link computePendingLiveness}.
 */
export function isFinalizableStatus(status: Concert['status']): boolean {
  return FINALIZABLE_STATUSES.has(status);
}
