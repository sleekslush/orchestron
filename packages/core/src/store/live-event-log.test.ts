import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveEventLog } from './live-event-log.js';
import type { ConcertEvent } from '../types/events.js';

describe('LiveEventLog', () => {
  let tracesDir: string;
  let log: LiveEventLog;

  beforeEach(async () => {
    tracesDir = join(tmpdir(), `orchestron-live-${Date.now()}`);
    await mkdir(tracesDir, { recursive: true });
    log = new LiveEventLog(tracesDir);
  });

  afterEach(async () => {
    await log.dispose();
    await rm(tracesDir, { recursive: true, force: true });
  });

  function event(type: ConcertEvent['type'], overrides: Partial<ConcertEvent> = {}): ConcertEvent {
    return {
      type,
      concertId: 'c1',
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      ...overrides,
    } as ConcertEvent;
  }

  it('appends and reads events for a concert', async () => {
    await log.append('c1', event('concert:started', { scoreId: 's' }));
    await log.append('c1', event('movement:started', { movementId: 'm1' }));

    const events = await log.read('c1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('concert:started');
    expect(events[1].type).toBe('movement:started');
    expect(events[1]).toMatchObject({ movementId: 'm1' });
  });

  it('returns empty array for a concert with no log', async () => {
    expect(await log.read('missing')).toEqual([]);
  });

  it('readSince returns only events after a byte offset', async () => {
    await log.append('c1', event('concert:started', { scoreId: 's' }));
    await log.append('c1', event('movement:started', { movementId: 'm1' }));

    const first = await log.readSince('c1', 0);
    expect(first.events).toHaveLength(2);

    const second = await log.readSince('c1', 0);
    const delta = await log.readSince('c1', first.bytesRead);
    expect(delta.events).toHaveLength(0);

    // Append more and read the tail.
    await log.append('c1', event('movement:completed', { movementId: 'm1' }));
    const tail = await log.readSince('c1', second.bytesRead);
    expect(tail.events).toHaveLength(1);
    expect(tail.events[0].type).toBe('movement:completed');
  });

  it('close prevents further appends for that concert', async () => {
    await log.append('c1', event('concert:started', { scoreId: 's' }));
    await log.close('c1');
    await log.append('c1', event('movement:started', { movementId: 'm1' }));

    const events = await log.read('c1');
    expect(events).toHaveLength(1);
  });

  it('watch tails newly appended events', async () => {
    await log.append('c1', event('concert:started', { scoreId: 's' }));

    const seen: ConcertEvent[] = [];
    const watchPromise = (async () => {
      for await (const batch of log.watch('c1')) {
        seen.push(...batch);
        if (seen.length >= 2) break;
      }
    })();

    // Append after the watcher has started so it observes an incremental write.
    await new Promise((r) => setTimeout(r, 50));
    await log.append('c1', event('movement:started', { movementId: 'm1' }));
    await watchPromise;

    expect(seen.some((e) => e.type === 'concert:started')).toBe(true);
    expect(seen.some((e) => e.type === 'movement:started')).toBe(true);
  });

  it('skips malformed JSON lines', async () => {
    await log.append('c1', event('concert:started', { scoreId: 's' }));
    // Write a malformed line directly to the file.
    const fs = await import('node:fs');
    fs.appendFileSync(join(tracesDir, 'c1', 'live.jsonl'), 'not json\n');
    await log.append('c1', event('movement:started', { movementId: 'm1' }));

    const events = await log.read('c1');
    expect(events.map((e) => e.type)).toEqual(['concert:started', 'movement:started']);
  });
});
