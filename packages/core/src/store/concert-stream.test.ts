import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConcertStream, streamRecordToEvent, streamRecordsToEvents } from './concert-stream.js';
import type { ConcertEvent } from '../types/events.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'orchestron-stream-'));
}

function record(overrides: Partial<Parameters<ConcertStream['append']>[1]> = {}) {
  return {
    ts: '2025-01-01T00:00:00.000Z',
    source: 'sdk' as const,
    type: 'message_update',
    concertId: 'c1',
    movementId: 'm1',
    attempt: 0,
    harness: 'pi',
    data: { id: 1 },
    ...overrides,
  };
}

describe('ConcertStream', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends envelopes and reads them back in order', async () => {
    const stream = new ConcertStream(dir);
    await stream.append('c1', record({ type: 'a', data: { n: 1 } }));
    await stream.append('c1', record({ type: 'b', data: { n: 2 } }));
    await stream.append('c1', record({ type: 'c', data: { n: 3 } }));

    const records = await stream.read('c1');
    expect(records.map((r) => r.type)).toEqual(['a', 'b', 'c']);
    expect(records[0].data).toEqual({ n: 1 });
    expect(records[0].concertId).toBe('c1');
    await stream.close('c1');
  });

  it('serialization failures are logged loudly and skipped, never thrown', async () => {
    const stream = new ConcertStream(dir);
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(stream.append('c1', record({ type: 'cyclic', data: cyclic }))).resolves.toBeUndefined();
    await stream.append('c1', record({ type: 'fine', data: { ok: true } }));

    const records = await stream.read('c1');
    expect(records.map((r) => r.type)).toEqual(['fine']);
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    await stream.close('c1');
  });

  it('readEvents only returns concert records and restores Date timestamps', async () => {
    const stream = new ConcertStream(dir);
    const concertEvent: ConcertEvent = {
      type: 'movement:started',
      concertId: 'c1',
      movementId: 'm1',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      prompt: 'hello',
    };
    await stream.append('c1', record({ source: 'concert', type: 'movement:started', data: concertEvent }));
    await stream.append('c1', record({ source: 'sdk', type: 'message_update', data: { id: 9 } }));

    const events = await stream.readEvents('c1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('movement:started');
    expect(events[0].timestamp).toBeInstanceOf(Date);
    await stream.close('c1');
  });

  it('streamRecordToEvent ignores sdk records and non-event data', () => {
    expect(streamRecordToEvent(record({ source: 'sdk' }))).toBeUndefined();
    expect(streamRecordToEvent(record({ source: 'concert', data: { notAnEvent: true } }))).toBeUndefined();
    const event = streamRecordToEvent(
      record({
        source: 'concert',
        type: 'concert:completed',
        data: { type: 'concert:completed', concertId: 'c1', timestamp: '2025-01-01T00:00:00.000Z' },
      }),
    );
    expect(event?.timestamp).toBeInstanceOf(Date);
  });

  it('readSince resumes from a UTF-16 code-unit offset', async () => {
    const stream = new ConcertStream(dir);
    await stream.append('c1', record({ type: 'one', data: 'first' }));
    const first = await stream.readSince('c1', 0);
    expect(first.records.map((r) => r.type)).toEqual(['one']);
    expect(first.bytesRead).toBeGreaterThan(0);

    await stream.append('c1', record({ type: 'two', data: 'second' }));
    const second = await stream.readSince('c1', first.bytesRead);
    expect(second.records.map((r) => r.type)).toEqual(['two']);
    await stream.close('c1');
  });

  it('watch yields initial records then newly appended ones', async () => {
    const stream = new ConcertStream(dir);
    await stream.append('c1', record({ type: 'initial' }));

    const iterator = stream.watch('c1');
    const first = await iterator.next();
    expect((first.value ?? []) as Array<{ type: string }>).toHaveProperty('length', 1);
    expect(((first.value ?? []) as Array<{ type: string }>)[0]!.type).toEqual('initial');

    const appendPromise = stream.append('c1', record({ type: 'tail' }));
    const second = await iterator.next();
    expect((second.value ?? []) as Array<{ type: string }>).toHaveProperty('length', 1);
    expect(((second.value ?? []) as Array<{ type: string }>)[0]!.type).toEqual('tail');
    await appendPromise;
    await iterator.return(undefined as void);
    await stream.close('c1');
  });

  it('append after close is a no-op', async () => {
    const stream = new ConcertStream(dir);
    await stream.append('c1', record({ type: 'a' }));
    await stream.close('c1');
    await stream.append('c1', record({ type: 'b' }));
    const records = await stream.read('c1');
    expect(records.map((r) => r.type)).toEqual(['a']);
  });

  it('append for a fresh concert does not clobber existing stream data', async () => {
    const stream = new ConcertStream(dir);
    await stream.append('c1', record({ type: 'a' }));
    const contentBefore = readFileSync(join(dir, 'c1', 'stream.jsonl'), 'utf-8');
    await stream.append('c1', record({ type: 'b' }));
    const contentAfter = readFileSync(join(dir, 'c1', 'stream.jsonl'), 'utf-8');
    expect(contentAfter.startsWith(contentBefore.trimEnd())).toBe(true);
    expect((await stream.read('c1')).map((r) => r.type)).toEqual(['a', 'b']);
    await stream.close('c1');
  });

  it('streamRecordsToEvents filters and maps', async () => {
    const events = streamRecordsToEvents([
      record({ source: 'sdk', type: 'x' }),
      record({
        source: 'concert',
        type: 'concert:failed',
        data: { type: 'concert:failed', concertId: 'c1', timestamp: '2025-01-01T00:00:00.000Z', error: { message: 'boom' } },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('concert:failed');
  });
});