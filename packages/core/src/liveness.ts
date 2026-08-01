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
