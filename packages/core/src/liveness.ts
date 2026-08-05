import { hostname } from 'node:os';
import type { Concert } from './types/concert.js';

/** Interval at which the conductor reports a concert-level heartbeat. */
export const CONCERT_HEARTBEAT_INTERVAL_MS = 5000;

/**
 * How long since the last heartbeat before a running concert is considered
 * stale. Generous enough to absorb inter-movement gaps (evaluator calls) and
 * clock skew without flagging a healthy concert.
 */
export const CONCERT_STALE_AFTER_MS = 60_000;

/** Statuses whose hosting process is expected to be alive and heartbeating. */
const LIVENESS_RELEVANT_STATUSES = new Set(['running', 'paused']);

/**
 * Extra buffer on top of {@link CONCERT_STALE_AFTER_MS} before a `pending`
 * concert may be judged dead. `pending` rows are created before the conductor
 * starts and never heartbeat, so liveness cannot compare against a heartbeat.
 * Instead we treat the persisted creation timestamp (`startedAt`) as the floor:
 * a row younger than this floor is "never started yet" (a concert about to
 * begin, or one slowly rehydrating) and MUST NOT be touched. Only rows older
 * than the staleness floor plus this grace buffer are candidates for the
 * "died before start" cleanup.
 */
export const PENDING_STALE_GRACE_MS = 30_000;

/**
 * How old a `pending` concert must be (since its persisted creation timestamp)
 * before it may be treated as "died before start". Kept conservative to avoid
 * racing a concert that is about to begin.
 */
export const PENDING_STALE_AFTER_MS = CONCERT_STALE_AFTER_MS + PENDING_STALE_GRACE_MS;

export type LivenessReason = 'pid_dead' | 'heartbeat_stale';

export interface LivenessInfo {
  /** Whether the concert's hosting process looks dead. */
  stale: boolean;
  /** Why liveness failed, when known. */
  reason?: LivenessReason;
  /** Last time the process reported itself alive. */
  lastSeenAt?: Date;
  /** Seconds elapsed since the last heartbeat (0 when never / just seen). */
  secondsSinceLastSeen?: number;
}

/**
 * Same-host liveness probe: `process.kill(pid, 0)` does not kill, it only
 * checks whether a process with `pid` exists and is signalable. It returns
 * true when the process is alive (or exists but is not ours — EPERM) and false
 * only when it conclusively does not exist (ESRCH). Refuses to judge across
 * hosts, where heartbeat staleness is the only signal.
 */
export function isProcessAlive(pid: number, hostnameToCheck: string): boolean {
  if (hostnameToCheck !== hostname()) {
    // Cross-host: can't probe the remote PID. Fall back to heartbeat staleness.
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user; treat as alive.
    return code === 'EPERM';
  }
}

/**
 * Derive liveness from the persisted PID/hostname and concert-level heartbeat.
 * Only makes sense for statuses whose hosting process should still be alive;
 * terminal concerts are never stale. Used by reader-side commands (`list`,
 * `status`) to surface dead concerts without waiting on the conductor.
 */
export function computeLiveness(
  concert: Pick<Concert, 'processId' | 'hostname' | 'lastHeartbeatAt' | 'startedAt'> & {
    status: string;
  },
): LivenessInfo {
  if (!LIVENESS_RELEVANT_STATUSES.has(concert.status)) {
    return { stale: false };
  }

  const now = Date.now();
  const lastSeenAt = concert.lastHeartbeatAt ?? concert.startedAt;
  const secondsSinceLastSeen = Math.max(0, Math.floor((now - lastSeenAt.getTime()) / 1000));

  let stale = false;
  let reason: LivenessReason | undefined;

  if (concert.processId !== undefined && concert.hostname !== undefined) {
    if (!isProcessAlive(concert.processId, concert.hostname)) {
      stale = true;
      reason = 'pid_dead';
    }
  }

  if (now - lastSeenAt.getTime() > CONCERT_STALE_AFTER_MS) {
    stale = true;
    reason = reason ?? 'heartbeat_stale';
  }

  return { stale, reason, lastSeenAt, secondsSinceLastSeen };
}

/**
 * Derive liveness for a `pending` concert, i.e. one whose process never reached
 * a first heartbeat. Distinguishes two cases:
 *
 * - **Never started yet**: the persisted creation timestamp (`startedAt`) is
 *   younger than {@link PENDING_STALE_AFTER_MS}. Conservatively treated as a
 *   concert about to begin / slowly rehydrating — never stale.
 * - **Died before start**: older than the floor AND the process cannot be
 *   confirmed alive (same-host PID is gone, or — where the PID can't be probed,
 *   e.g. cross-host — no heartbeat has been seen since creation). Finalizable.
 *
 * A live process on a checkable host is never stale, even if old: it may be
 * taking a long time to (re)hydrate.
 */
export function computePendingLiveness(
  concert: Pick<Concert, 'processId' | 'hostname' | 'startedAt' | 'lastHeartbeatAt'> & {
    status: string;
  },
): LivenessInfo {
  if (concert.status !== 'pending') {
    return { stale: false };
  }

  const now = Date.now();
  const lastSeenAt = concert.lastHeartbeatAt ?? concert.startedAt;
  const secondsSinceLastSeen = Math.max(0, Math.floor((now - lastSeenAt.getTime()) / 1000));

  // Creation-vs-start boundary: below the floor it hasn't been pending long
  // enough to be considered dead — a concert that never started yet.
  if (now - concert.startedAt.getTime() <= PENDING_STALE_AFTER_MS) {
    return { stale: false, lastSeenAt, secondsSinceLastSeen };
  }

  // A same-host process can be probed definitively: only a confirmed dead PID
  // marks the row as "died before start". A confirmed-alive same-host process
  // is left alone even if the row is old (it may be slowly rehydrating).
  if (
    concert.processId !== undefined &&
    concert.hostname !== undefined &&
    concert.hostname === hostname()
  ) {
    if (!isProcessAlive(concert.processId, concert.hostname)) {
      return { stale: true, reason: 'pid_dead', lastSeenAt, secondsSinceLastSeen };
    }
    return { stale: false, lastSeenAt, secondsSinceLastSeen };
  }

  // No probeable PID (cross-host or never recorded): the PID can't confirm
  // liveness, so heartbeat absence since the creation timestamp is the only
  // signal. Old + no heartbeat since creation -> died before start.
  if (now - lastSeenAt.getTime() > CONCERT_STALE_AFTER_MS) {
    return { stale: true, reason: 'heartbeat_stale', lastSeenAt, secondsSinceLastSeen };
  }

  return { stale: false, lastSeenAt, secondsSinceLastSeen };
}
