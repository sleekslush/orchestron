import { describe, it, expect } from 'vitest';
import { hostname } from 'node:os';
import type { Concert } from '../types/concert.js';
import {
  computeLiveness,
  computePendingLiveness,
  isProcessAlive,
  CONCERT_STALE_AFTER_MS,
  PENDING_STALE_AFTER_MS,
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
      makeConcert({ processId: process.pid, hostname: hostname(), lastHeartbeatAt: new Date() }),
    );
    expect(live.stale).toBe(false);
  });

  it('flags a concert stale when the hosting process is gone', () => {
    // A PID that cannot exist: use a very high value unlikely to be in use.
    const pid = 2_000_000_000;
    // Assert the precondition loudly so an environmental change (e.g. an OS
    // that recycles huge PIDs) fails the test rather than silently skipping it.
    expect(isProcessAlive(pid, hostname())).toBe(false);
    const info = computeLiveness(
      makeConcert({ processId: pid, hostname: hostname(), lastHeartbeatAt: new Date() }),
    );
    expect(info.stale).toBe(true);
    expect(info.reason).toBe('pid_dead');
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
        hostname: hostname(),
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
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
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

describe('computePendingLiveness', () => {
  it('never flags a pending concert younger than the staleness floor', () => {
    const info = computePendingLiveness(
      makeConcert({
        status: 'pending',
        startedAt: new Date(),
        processId: 2_000_000_000,
        hostname: hostname(),
      }),
    );
    expect(info.stale).toBe(false);
  });

  it('flags an old pending concert whose same-host process is dead', () => {
    const info = computePendingLiveness(
      makeConcert({
        status: 'pending',
        startedAt: new Date(Date.now() - PENDING_STALE_AFTER_MS - 60_000),
        processId: 2_000_000_000,
        hostname: hostname(),
      }),
    );
    expect(info.stale).toBe(true);
    expect(info.reason).toBe('pid_dead');
  });

  it('does not flag an old pending concert whose same-host process is alive', () => {
    const info = computePendingLiveness(
      makeConcert({
        status: 'pending',
        startedAt: new Date(Date.now() - PENDING_STALE_AFTER_MS - 60_000),
        processId: process.pid,
        hostname: hostname(),
      }),
    );
    expect(info.stale).toBe(false);
  });

  it('flags an old cross-host pending concert with no heartbeat since creation', () => {
    const info = computePendingLiveness(
      makeConcert({
        status: 'pending',
        startedAt: new Date(Date.now() - PENDING_STALE_AFTER_MS - 60_000),
        processId: 1,
        hostname: 'remote-host',
      }),
    );
    expect(info.stale).toBe(true);
    expect(info.reason).toBe('heartbeat_stale');
  });

  it('returns not stale for non-pending statuses', () => {
    for (const status of ['running', 'paused', 'completed', 'failed', 'cancelled'] as const) {
      const info = computePendingLiveness(makeConcert({ status }));
      expect(info.stale).toBe(false);
    }
  });
});
