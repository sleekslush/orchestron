import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hostname } from 'node:os';
import { SqliteLoge } from '../store/sqlite-loge.js';
import type { Concert } from '../types/concert.js';
import type { ConcertEvent } from '../types/events.js';
import {
  finalizeStaleConcert,
  finalizeAllStale,
  isFinalizableStatus,
  FINALIZE_STALE_REASON,
} from '../finalize-stale.js';
import { CONCERT_STALE_AFTER_MS } from '../liveness.js';

describe('finalizeStaleConcert', () => {
  let store: SqliteLoge;

  beforeEach(() => {
    store = new SqliteLoge(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const makeConcert = (overrides: Partial<Concert> = {}): Concert => ({
    id: 'c1',
    scoreId: 's1',
    status: 'running',
    startedAt: new Date(),
    completedAt: undefined,
    currentMovement: null,
    history: [],
    context: { shared: {} },
    usage: {},
    triggeredBy: 'cli',
    childConcertIds: [],
    ...overrides,
  });

  // A PID that cannot exist, so liveness is conclusively pid_dead.
  const DEAD_PID = 2_000_000_000;

  it('finalizes a stale running concert whose process is dead, stamping process_died', async () => {
    await store.saveConcert(
      makeConcert({ status: 'running', processId: DEAD_PID, hostname: hostname() }),
      '',
    );

    const events: ConcertEvent[] = [];
    const result = await finalizeStaleConcert(store, 'c1', {
      recordEvent: (e) => void events.push(e),
    });

    expect(result.finalized).toBe(true);
    expect(result.reason).toBe('pid_dead');

    const updated = await store.getConcert('c1');
    expect(updated!.status).toBe('failed');
    expect(updated!.completedAt).toBeInstanceOf(Date);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('concert:failed');
    if (events[0].type === 'concert:failed') {
      expect(events[0].error.code).toBe(FINALIZE_STALE_REASON);
    }
  });

  it('finalizes a running concert whose heartbeat is beyond the grace period', async () => {
    await store.saveConcert(
      makeConcert({
        status: 'running',
        // Live PID but no heartbeat in a long time -> heartbeat_stale.
        processId: process.pid,
        hostname: hostname(),
        lastHeartbeatAt: new Date(Date.now() - CONCERT_STALE_AFTER_MS - 30_000),
      }),
      '',
    );

    const result = await finalizeStaleConcert(store, 'c1');
    expect(result.finalized).toBe(true);
    expect(result.reason).toBe('heartbeat_stale');
    expect((await store.getConcert('c1'))!.status).toBe('failed');
  });

  it('does nothing for a live, fresh-heartbeat running concert', async () => {
    await store.saveConcert(
      makeConcert({
        status: 'running',
        processId: process.pid,
        hostname: hostname(),
        lastHeartbeatAt: new Date(),
      }),
      '',
    );

    const result = await finalizeStaleConcert(store, 'c1');
    expect(result.finalized).toBe(false);
    expect((await store.getConcert('c1'))!.status).toBe('running');
  });

  it('does nothing for a paused concert that is not yet stale', async () => {
    await store.saveConcert(
      makeConcert({
        status: 'paused',
        processId: process.pid,
        hostname: hostname(),
        lastHeartbeatAt: new Date(),
      }),
      '',
    );

    const result = await finalizeStaleConcert(store, 'c1');
    expect(result.finalized).toBe(false);
    expect((await store.getConcert('c1'))!.status).toBe('paused');
  });

  it('finalizes a stale paused concert as failed', async () => {
    await store.saveConcert(
      makeConcert({
        status: 'paused',
        processId: DEAD_PID,
        hostname: hostname(),
      }),
      '',
    );

    const result = await finalizeStaleConcert(store, 'c1');
    expect(result.finalized).toBe(true);
    expect((await store.getConcert('c1'))!.status).toBe('failed');
  });

  it('never touches terminal or pending concerts', async () => {
    for (const status of ['failed', 'completed', 'cancelled', 'pending'] as const) {
      const id = `c-${status}`;
      await store.saveConcert(
        makeConcert({
          id,
          status,
          processId: DEAD_PID,
          hostname: hostname(),
          lastHeartbeatAt: new Date(Date.now() - CONCERT_STALE_AFTER_MS - 30_000),
        }),
        '',
      );

      const result = await finalizeStaleConcert(store, id);
      expect(result.finalized).toBe(false);
      expect((await store.getConcert(id))!.status).toBe(status);
    }
  });

  it('does not finalize a missing concert', async () => {
    const result = await finalizeStaleConcert(store, 'nope');
    expect(result.finalized).toBe(false);
  });

  it('finalizeAllStale cleans up every stale concert and leaves live ones alone', async () => {
    await store.saveConcert(
      makeConcert({ id: 'dead', status: 'running', processId: DEAD_PID, hostname: hostname() }),
      '',
    );
    await store.saveConcert(
      makeConcert({
        id: 'live',
        status: 'running',
        processId: process.pid,
        hostname: hostname(),
        lastHeartbeatAt: new Date(),
      }),
      '',
    );

    const results = await finalizeAllStale(store);
    expect(results.map((r) => r.concertId).sort()).toEqual(['dead']);
    expect((await store.getConcert('dead'))!.status).toBe('failed');
    expect((await store.getConcert('live'))!.status).toBe('running');
  });

  it('atomically refuses to flip a row a concurrently-completing conductor just completed', async () => {
    await store.saveConcert(
      makeConcert({ status: 'running', processId: DEAD_PID, hostname: hostname() }),
      '',
    );

    // Simulate a concurrently-completing conductor: the very first time the
    // finalizer issues the atomic CAS flip, the persisted row has already been
    // transitioned to 'completed', so the conditional UPDATE matches 0 rows and
    // must NOT clobber it back to 'failed'.
    const originalCas = store.updateConcertIfStatus.bind(store);
    let casCalls = 0;
    vi.spyOn(store, 'updateConcertIfStatus').mockImplementation(async (id, updates, expected) => {
      casCalls++;
      if (casCalls === 1) {
        // Flip the persisted row to 'completed' before the atomic update runs.
        await store.updateConcert({ id, status: 'completed', completedAt: new Date() });
      }
      return originalCas(id, updates, expected);
    });
    const events: ConcertEvent[] = [];

    const result = await finalizeStaleConcert(store, 'c1', {
      recordEvent: (e) => void events.push(e),
    });

    expect(result.finalized).toBe(false);
    expect(events).toHaveLength(0);
    // The concurrent transition to 'completed' won the race; the stale finalizer
    // must not have overwritten it.
    expect((await store.getConcert('c1'))!.status).toBe('completed');
  });

  it('updateConcertIfStatus matches 0 rows against non-matching statuses and leaves them untouched', async () => {
    for (const status of ['running', 'completed', 'failed', 'pending'] as const) {
      const id = `cas-${status}`;
      await store.saveConcert(makeConcert({ id, status, processId: DEAD_PID, hostname: hostname() }), '');
    }

    // A running row matches and is flipped.
    expect(await store.updateConcertIfStatus('cas-running', { status: 'failed', completedAt: new Date() }, ['running', 'paused'])).toBe(1);
    // Non-matching statuses match 0 rows and stay untouched.
    expect(await store.updateConcertIfStatus('cas-completed', { status: 'failed', completedAt: new Date() }, ['running', 'paused'])).toBe(0);
    expect(await store.updateConcertIfStatus('cas-failed', { status: 'failed', completedAt: new Date() }, ['running', 'paused'])).toBe(0);
    expect(await store.updateConcertIfStatus('cas-pending', { status: 'failed', completedAt: new Date() }, ['running', 'paused'])).toBe(0);
    expect((await store.getConcert('cas-completed'))!.status).toBe('completed');
    expect((await store.getConcert('cas-failed'))!.status).toBe('failed');
    expect((await store.getConcert('cas-pending'))!.status).toBe('pending');
  });

  it('isFinalizableStatus only admits liveness-relevant statuses', () => {
    expect(isFinalizableStatus('running')).toBe(true);
    expect(isFinalizableStatus('paused')).toBe(true);
    expect(isFinalizableStatus('pending')).toBe(false);
    expect(isFinalizableStatus('completed')).toBe(false);
    expect(isFinalizableStatus('failed')).toBe(false);
    expect(isFinalizableStatus('cancelled')).toBe(false);
  });
});
