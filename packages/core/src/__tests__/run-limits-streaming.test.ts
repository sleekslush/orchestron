import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Movement, Program, Score } from '../types/score.js';
import type { ConcertEvent } from '../types/events.js';

const NODE = process.execPath;

function makeHall(
  score: Score,
  tracesDir: string,
  harnessSpend = 5,
): { hall: ConcertHall; store: SqliteLoge } {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(score);
  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: new Map([
      [
        'fake',
        new FakeHarnessAdapter({
          defaultResponse: {
            output: 'harness output',
            summary: 'done',
            usage: { spend: harnessSpend, tokens: 50 },
          },
        }),
      ],
    ]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    defaultHarness: 'fake',
    tracesDir,
  });
  return { hall, store };
}

function runMovement(id: string, transitions: Movement['transitions']): Movement {
  return {
    id,
    name: id,
    section: 'execution',
    type: 'run',
    command: [NODE, '-e', 'process.exit(0)'],
    transitions,
  };
}

function harnessMovement(id: string, transitions: Movement['transitions']): Movement {
  return {
    id,
    name: id,
    section: 'execution',
    harness: 'fake',
    prompt: 'do it',
    goal: { description: 'done', strategy: 'llm_judge' },
    transitions,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'orchestron-mixed-'));
}

describe('mixed run + harness concerts', () => {
  it('accumulates measured $0 from run movements without becoming unknown', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'run-only',
      name: 'Run Only',
      version: '1.0.0',
      startMovement: 'a',
      movements: [runMovement('a', [{ to: '__end__', on: 'success' }])],
      program: {},
    };
    const { hall } = makeHall(score, dir);
    const conductor = await hall.createConcert('run-only');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const state = await conductor.getState();
    expect(state.usage.spend).toBe(0);
    expect(state.usage.spendSource).toBe('measured');
  });

  it('keeps a mixed concert measured (no unknown / ~$) and runs both kinds', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'mixed',
      name: 'Mixed',
      version: '1.0.0',
      startMovement: 'run',
      movements: [
        runMovement('run', [{ to: 'work', on: 'success' }]),
        harnessMovement('work', [{ to: '__end__', on: 'success' }]),
      ],
      program: { maxMovements: 2 },
    };
    const { hall, store } = makeHall(score, dir, 5);
    const conductor = await hall.createConcert('mixed');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const state = await conductor.getState();
    expect(state.usage.spend).toBe(5);
    expect(state.usage.spendSource).toBe('measured');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history.map((h) => h.movementId)).toEqual(['run', 'work']);
    expect(history[0].usage.spend).toBe(0);
    expect(history[0].usage.spendSource).toBe('measured');
  });

  it('counts run movements toward the program movement limit', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'mixed-limit',
      name: 'Mixed Limit',
      version: '1.0.0',
      startMovement: 'run',
      movements: [
        runMovement('run', [{ to: 'work', on: 'success' }]),
        harnessMovement('work', [{ to: '__end__', on: 'success' }]),
      ],
      program: { maxMovements: 1 },
    };
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('mixed-limit');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history.map((h) => h.movementId)).toEqual(['run']);
  });

  it('counts run movements toward the section movement limit', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'section-limit',
      name: 'Section Limit',
      version: '1.0.0',
      startMovement: 'a',
      movements: [
        runMovement('a', [{ to: 'b', on: 'success' }]),
        runMovement('b', [{ to: '__end__', on: 'success' }]),
      ],
      program: { perSection: { execution: { maxMovements: 1 } } } as Program,
    };
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('section-limit');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history.map((h) => h.movementId)).toEqual(['a']);
  });

  it('applies the program duration limit to run movements', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'duration-limit',
      name: 'Duration Limit',
      version: '1.0.0',
      startMovement: 'slow',
      movements: [
        {
          id: 'slow',
          name: 'slow',
          section: 'execution',
          type: 'run',
          command: [NODE, '-e', 'setTimeout(()=>process.exit(0), 30000)'],
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: { maxDurationMs: 200 },
    };
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('duration-limit');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].error?.code).toBe('MOVEMENT_ABORTED');
  });
});

describe('incremental run streaming', () => {
  it('emits stream records and partial logs before the process exits', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'staged',
      name: 'Staged',
      version: '1.0.0',
      startMovement: 'run',
      movements: [
        {
          id: 'run',
          name: 'run',
          section: 'execution',
          type: 'run',
          command: [
            NODE,
            '-e',
            'process.stdout.write("first");setTimeout(()=>{process.stdout.write(" second");process.exit(0)}, 1000)',
          ],
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    const { hall } = makeHall(score, dir);
    const conductor = await hall.createConcert('staged');
    const events: ConcertEvent[] = [];
    conductor.onEvent((e) => events.push(e));

    const running = conductor.start();

    // Wait until the first chunk is observed while the child is still running.
    const deadline = Date.now() + 800;
    while (
      Date.now() < deadline &&
      !events.some(
        (e) =>
          e.type === 'movement:progress' &&
          e.progressType === 'run_stdout' &&
          e.payload.chunk === 'first',
      )
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const sawFirstBeforeExit =
      events.some(
        (e) =>
          e.type === 'movement:progress' &&
          e.progressType === 'run_stdout' &&
          e.payload.chunk === 'first',
      ) && !events.some((e) => e.type === 'movement:progress' && e.progressType === 'run_exit');
    expect(sawFirstBeforeExit).toBe(true);

    await running;
    const attemptStdout = join(dir, conductor.concertId, 'movements', 'run', 'attempt-0', 'stdout.log');
    expect(readFileSync(attemptStdout, 'utf-8')).toBe('first second');
  });

  it('keeps partial logs and stream records on abort and resolves failure via the arrows', async () => {
    const dir = tmp();
    const score: Score = {
      id: 'abort-partial',
      name: 'Abort Partial',
      version: '1.0.0',
      startMovement: 'run',
      movements: [
        {
          id: 'run',
          name: 'run',
          section: 'execution',
          type: 'run',
          command: [
            NODE,
            '-e',
            'process.stdout.write("partial-out");process.stderr.write("partial-err");setTimeout(()=>process.exit(0), 60000)',
          ],
          budget: { timeoutMs: 300 },
          transitions: [
            { to: '__end__', on: 'success' },
            { to: 'fail_cleanup', on: 'failure' },
          ],
        },
        {
          id: 'fail_cleanup',
          name: 'fail_cleanup',
          section: 'cleanup',
          type: 'run',
          command: [NODE, '-e', 'process.exit(0)'],
          transitions: [{ to: '__fail__', on: 'any' }],
        },
      ],
      program: {},
    };
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('abort-partial');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].status).toBe('failed');
    expect(history[0].error?.code).toBe('MOVEMENT_ABORTED');
    // The score's `on: failure` arrow still runs the deterministic cleanup.
    expect(history.map((h) => h.movementId)).toContain('fail_cleanup');

    const attemptDir = join(dir, conductor.concertId, 'movements', 'run', 'attempt-0');
    expect(readFileSync(join(attemptDir, 'stdout.log'), 'utf-8')).toBe('partial-out');
    expect(readFileSync(join(attemptDir, 'stderr.log'), 'utf-8')).toBe('partial-err');

    const progress = (await hall.getConcertStream()!.readEvents(conductor.concertId)).filter(
      (e): e is ConcertEvent & { type: 'movement:progress' } => e.type === 'movement:progress',
    );
    expect(
      progress.some((e) => e.progressType === 'run_stdout' && e.payload.chunk === 'partial-out'),
    ).toBe(true);
    expect(
      progress.some((e) => e.progressType === 'run_stderr' && e.payload.chunk === 'partial-err'),
    ).toBe(true);
  });
});
