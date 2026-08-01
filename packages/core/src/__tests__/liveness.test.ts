import { describe, it, expect } from 'vitest';
import type { Concert } from '../types/concert.js';
import {
  computeLiveness,
  isProcessAlive,
  CONCERT_STALE_AFTER_MS,
} from '../liveness.js';

function makeConcert(overrides: Partial<Concert> = {}): Concert {
  const now = new Date();
  return {
    id: 'c1',
    scoreId: 's1',
    status: 'running',
    startedAt: new Date(now.getTime() - 100_000),
    completedAt: undefined,
    currentMovement: null,
    history: [],
    context: { shared: {} },
    usage: {},
    triggeredBy: 'cli',
    childConcertIds: [],
    ...overrides,
  };
}

describe('computeLiveness', () => {
  it('is not stale for a live process with a fresh heartbeat', () => {
    const live = computeLiveness(
      makeConcert({ processId: process.pid, hostname: 'local', lastHeartbeatAt: new Date() }),
    );
    expect(live.stale).toBe(false);
  });

  it('flags a concert stale when the hosting process is gone', () => {
    // A PID that cannot exist: use a very high value unlikely to be in use.
    const pid = 2_000_000_000;
    const info = computeLiveness(
      makeConcert({ processId: pid, hostname: 'local', lastHeartbeatAt: new Date() }),
    );
    // If the OS ever has such a huge PID (essentially never), skip; otherwise
    // deterministic since the process cannot exist.
    if (!isProcessAlive(pid, 'local')) {
      expect(info.stale).toBe(true);
      expect(info.reason).toBe('pid_dead');
    }
  });

  it('does not judge a cross-host process by PID (falls back to heartbeat)', () => {
    const info = computeLiveness(
      makeConcert({ processId: 1, hostname: 'remote-host', lastHeartbeatAt: new Date() }),
    );
    expect(info.stale).toBe(false);
  });

  it('flags heartbeats older than the stale window', () => {
    const info = computeLiveness(
      makeConcert({
        processId: process.pid,
        hostname: 'local',
        lastHeartbeatAt: new Date(Date.now() - CONCERT_STALE_AFTER_MS - 10_000),
      }),
    );
    expect(info.stale).toBe(true);
    expect(info.secondsSinceLastSeen).toBeGreaterThan(CONCERT_STALE_AFTER_MS / 1000);
  });

  it('reports seconds since last heartbeat', () => {
    const info = computeLiveness(
      makeConcert({ lastHeartbeatAt: new Date(Date.now() - 30_000) }),
    );
    expect(info.secondsSinceLastSeen).toBe(30);
  });

  it('never flags terminal concerts', () => {
    for (const status of ['pending', 'completed', 'failed', 'cancelled'] as const) {
      const info = computeLiveness(
        makeConcert({
          status,
          lastHeartbeatAt: new Date(Date.now() - CONCERT_STALE_AFTER_MS - 10_000),
        }),
      );
      expect(info.stale).toBe(false);
    }
  });
});
