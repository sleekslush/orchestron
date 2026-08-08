import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concertLog, type ConcertLogLine } from '../store/concert-log.js';

const MOVEMENTS = [
  {
    order: 1,
    movementId: 'answer',
    attempt: 1,
    status: 'completed',
    startedAt: '2026-08-07T22:43:37.663Z',
    completedAt: '2026-08-07T22:43:54.036Z',
    durationMs: 16373,
    harness: 'pi',
    format: 'pi/session-event@1',
    exportFile: 'exports/0001.answer.jsonl',
    session: {
      id: 's-1',
      dir: 'sessions/answer',
      file: 'sessions/answer/x.jsonl',
      reopenHint: 'pi --session sessions/answer/x.jsonl',
    },
  },
  {
    order: 2,
    movementId: 'sub',
    attempt: 1,
    status: 'completed',
    childConcertId: 'child-1',
  },
  {
    order: 3,
    movementId: 'answer',
    attempt: 2,
    status: 'failed',
    harness: 'pi',
    format: 'pi/session-event@1',
    exportFile: 'exports/0003.answer.jsonl',
    durationMs: 1000,
  },
];

const EXPORT_1 = [
  { type: 'session', version: 3, id: 's-1', timestamp: '2026-08-07T22:43:52.689Z' },
  { type: 'agent_start' },
  {
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'What is the capital of France?' }] },
  },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Paris.' } },
  { type: 'turn_end', message: { role: 'assistant', usage: { input: 100, output: 5 } } },
];

const EXPORT_2 = [{ type: 'agent_start' }];

function writeConcert(
  dir: string,
  concertId: string,
  status: 'running' | 'completed' = 'completed',
): { concertDir: string; manifestPath: string } {
  const concertDir = join(dir, concertId);
  mkdirSync(join(concertDir, 'exports'), { recursive: true });
  const manifest: Record<string, unknown> = {
    concertId,
    scoreId: 'hello-test',
    schema: 'orchestron/concert-manifest@1',
    status,
    createdAt: '2026-08-07T22:43:37.660Z',
    movements: MOVEMENTS,
  };
  if (status === 'completed') {
    manifest.completedAt = '2026-08-07T22:44:01.046Z';
  }
  writeFileSync(join(concertDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(concertDir, 'exports/0001.answer.jsonl'),
    EXPORT_1.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  writeFileSync(
    join(concertDir, 'exports/0003.answer.jsonl'),
    EXPORT_2.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return { concertDir, manifestPath: join(concertDir, 'manifest.json') };
}

async function collect(gen: AsyncGenerator<ConcertLogLine>): Promise<ConcertLogLine[]> {
  const lines: ConcertLogLine[] = [];
  for await (const line of gen) {
    lines.push(line);
  }
  return lines;
}

/**
 * Advance follow generators one step at a time. The generator may reach its
 * poll sleep only after real fs I/O completes, so keep advancing the fake
 * clock (firing any newly scheduled poll timers) until the pending next()
 * settles.
 */
async function nextAfterPoll(
  gen: AsyncGenerator<ConcertLogLine>,
  ms: number,
): Promise<IteratorResult<ConcertLogLine>> {
  const pending = gen.next();
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; !settled && i < 20; i++) {
    await vi.advanceTimersByTimeAsync(ms);
  }
  return pending;
}

describe('concertLog', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.useRealTimers();
  });

  it('yields the concert line with manifest fields, then movement lines and literal export events', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');

    const lines = await collect(concertLog(dir, 'c1'));

    expect(lines[0]).toEqual({
      type: 'orchestron:concert',
      concertId: 'c1',
      scoreId: 'hello-test',
      schema: 'orchestron/concert-manifest@1',
      status: 'completed',
      createdAt: '2026-08-07T22:43:37.660Z',
      completedAt: '2026-08-07T22:44:01.046Z',
    });
    expect(lines[1]).toEqual({
      type: 'orchestron:movement',
      order: 1,
      movementId: 'answer',
      attempt: 1,
      status: 'completed',
      startedAt: '2026-08-07T22:43:37.663Z',
      completedAt: '2026-08-07T22:43:54.036Z',
      durationMs: 16373,
      harness: 'pi',
      format: 'pi/session-event@1',
      exportFile: 'exports/0001.answer.jsonl',
      session: {
        id: 's-1',
        dir: 'sessions/answer',
        file: 'sessions/answer/x.jsonl',
        reopenHint: 'pi --session sessions/answer/x.jsonl',
      },
    });
    expect(lines.slice(2, 7)).toEqual(EXPORT_1);
    expect(lines[7]).toMatchObject({ type: 'orchestron:movement', order: 2, childConcertId: 'child-1' });
    expect(lines[8]).toMatchObject({ type: 'orchestron:movement', order: 3, attempt: 2, status: 'failed' });
    expect(lines[9]).toEqual(EXPORT_2[0]);
    expect(lines).toHaveLength(10);
  });

  it('omits absent fields from movement lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');

    const lines = await collect(concertLog(dir, 'c1'));

    expect(lines[7]).toEqual({
      type: 'orchestron:movement',
      order: 2,
      movementId: 'sub',
      attempt: 1,
      status: 'completed',
      childConcertId: 'child-1',
    });
  });

  it('throws when the concert has no recording', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    await expect(collect(concertLog(dir, 'nope'))).rejects.toThrow(/No recording for concert 'nope'/);
  });

  it('throws on a malformed export line with file and line context', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');
    writeFileSync(join(dir, 'c1/exports/0003.answer.jsonl'), '{"type":"agent_start"}\nNOT JSON\n');

    await expect(collect(concertLog(dir, 'c1'))).rejects.toThrow(
      /Unparseable export line 2 in .*0003\.answer\.jsonl/,
    );
  });

  it('skips a torn final export line (crash artifact) in static mode', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');
    writeFileSync(join(dir, 'c1/exports/0003.answer.jsonl'), '{"type":"agent_start"}\n{"type":"agent_end",');

    const lines = await collect(concertLog(dir, 'c1'));

    expect(lines).toHaveLength(10);
    expect(lines[9]).toEqual(EXPORT_2[0]);
  });

  it('throws when a movement entry references a missing export file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');
    rmSync(join(dir, 'c1/exports/0001.answer.jsonl'));

    await expect(collect(concertLog(dir, 'c1'))).rejects.toThrow(
      /Missing export file for movement: 'exports\/0001\.answer\.jsonl'/,
    );
  });

  it('follows: streams appended export lines, new movements, and the terminal concert line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    const { concertDir, manifestPath } = writeConcert(dir, 'c1', 'running');

    const gen = concertLog(dir, 'c1', { follow: true, pollIntervalMs: 50 });
    const lines: ConcertLogLine[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await gen.next();
      expect(res.done).toBe(false);
      lines.push(res.value);
    }
    expect(lines[0]).toMatchObject({ type: 'orchestron:concert', status: 'running' });
    expect(lines[0].completedAt).toBeUndefined();

    appendFileSync(join(concertDir, 'exports/0001.answer.jsonl'), JSON.stringify({ type: 'agent_settled' }) + '\n');
    const res = await nextAfterPoll(gen, 50);
    expect(res.done).toBe(false);
    expect(res.value).toEqual({ type: 'agent_settled' });

    const newMovement = {
      order: 4,
      movementId: 'confirm',
      attempt: 1,
      status: 'completed',
      harness: 'pi',
      format: 'pi/session-event@1',
      exportFile: 'exports/0004.confirm.jsonl',
    };
    writeFileSync(join(concertDir, 'exports/0004.confirm.jsonl'), JSON.stringify({ type: 'turn_end' }) + '\n');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          concertId: 'c1',
          scoreId: 'hello-test',
          schema: 'orchestron/concert-manifest@1',
          status: 'running',
          createdAt: '2026-08-07T22:43:37.660Z',
          movements: [...MOVEMENTS, newMovement],
        },
        null,
        2,
      ) + '\n',
    );

    const moved = await nextAfterPoll(gen, 50);
    expect(moved.done).toBe(false);
    expect(moved.value).toMatchObject({ type: 'orchestron:movement', order: 4, movementId: 'confirm' });
    const event = await nextAfterPoll(gen, 50);
    expect(event.done).toBe(false);
    expect(event.value).toEqual({ type: 'turn_end' });

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          concertId: 'c1',
          scoreId: 'hello-test',
          schema: 'orchestron/concert-manifest@1',
          status: 'completed',
          createdAt: '2026-08-07T22:43:37.660Z',
          completedAt: '2026-08-07T22:45:00.000Z',
          movements: [...MOVEMENTS, newMovement],
        },
        null,
        2,
      ) + '\n',
    );

    const final = await nextAfterPoll(gen, 50);
    expect(final.done).toBe(false);
    expect(final.value).toEqual({
      type: 'orchestron:concert',
      concertId: 'c1',
      scoreId: 'hello-test',
      schema: 'orchestron/concert-manifest@1',
      status: 'completed',
      createdAt: '2026-08-07T22:43:37.660Z',
      completedAt: '2026-08-07T22:45:00.000Z',
    });
    expect((await gen.next()).done).toBe(true);
  });

  it('follows: defers a torn trailing line until it completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    const { concertDir } = writeConcert(dir, 'c1', 'running');
    const exportPath = join(concertDir, 'exports/0003.answer.jsonl');
    writeFileSync(exportPath, '{"type":"agent_start"}\n{"type":"agent_end",');

    const gen = concertLog(dir, 'c1', { follow: true, pollIntervalMs: 50 });
    for (let i = 0; i < 10; i++) {
      const res = await gen.next();
      expect(res.done).toBe(false);
    }

    appendFileSync(exportPath, ' "done":true}\n');
    const res = await nextAfterPoll(gen, 50);
    expect(res.done).toBe(false);
    expect(res.value).toEqual({ type: 'agent_end', done: true });
  });

  it('follows: returns immediately when the concert is already terminal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1');

    const lines = await collect(concertLog(dir, 'c1', { follow: true, pollIntervalMs: 50 }));

    expect(lines).toHaveLength(10);
    expect(lines.filter((l) => l.type === 'orchestron:concert')).toHaveLength(1);
  });

  it('follows: stops when the signal aborts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'orchestron-log-'));
    writeConcert(dir, 'c1', 'running');

    const controller = new AbortController();
    const gen = concertLog(dir, 'c1', {
      follow: true,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    const lines: ConcertLogLine[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await gen.next();
      expect(res.done).toBe(false);
      lines.push(res.value);
    }

    controller.abort();
    const res = await nextAfterPoll(gen, 50);
    expect(res.done).toBe(true);
    expect(lines).toHaveLength(10);
  });
});
