import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import type { Goal, Movement, Score } from '../types/score.js';
import type { GoalEvaluation } from '../types/concert.js';
import type { Evaluator } from '../evaluator/evaluator.js';
import type { ConcertEvent } from '../types/events.js';

const NODE = process.execPath;

/** Evaluator spy that records every call; run movements must never invoke it. */
class SpyEvaluator implements Evaluator {
  calls = 0;
  constructor(private result: GoalEvaluation = { achieved: true, confidence: 1, summary: 'ok', evidence: '' }) {}
  async evaluate(_goal: Goal): Promise<GoalEvaluation> {
    this.calls += 1;
    return this.result;
  }
}

function movement(partial: Partial<Movement> & Pick<Movement, 'id'>): Movement {
  return {
    name: partial.id,
    section: 'default',
    transitions: [{ to: '__end__', on: 'success' }],
    ...partial,
  };
}

function makeHall(score: Score, evaluator: Evaluator, tracesDir: string): { hall: ConcertHall; store: SqliteLoge } {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(score);
  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: new Map(),
    evaluator,
    tracesDir,
  });
  return { hall, store };
}

function runScore(movements: Movement[], overrides: Partial<Score> = {}): Score {
  return {
    id: 'run-score',
    name: 'Run Score',
    version: '1.0.0',
    startMovement: movements[0].id,
    movements,
    program: {},
    ...overrides,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'orchestron-run-'));
}

describe('run movements', () => {
  it('executes argv with no adapter, never calls the evaluator, and records measured $0', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write("hello\\n")'],
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe('run');
    expect(history[0].exitCode).toBe(0);
    expect(history[0].output).toBe('hello\n');
    expect(history[0].usage.spend).toBe(0);
    expect(history[0].usage.spendSource).toBe('measured');
    expect(evaluator.calls).toBe(0);
  });

  it('maps exit codes through the per-movement outcomes map', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.exit(3)'],
        outcomes: { 0: 'success', 3: 'rejection', default: 'failure' },
        transitions: [
          { to: '__end__', on: 'success' },
          { to: '__fail__', on: 'rejection' },
          { to: '__fail__', on: 'failure' },
        ],
      }),
    ]);
    const { hall } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await (await conductor.getState()).history;
    expect(history[0].status).toBe('rejected');
    expect(history[0].exitCode).toBe(3);
    expect(history[0].error?.code).toBe('EXIT_NONZERO');
    expect(evaluator.calls).toBe(0);
    // The per-attempt metadata records the mapped rejection honestly.
    const meta = JSON.parse(
      readFileSync(
        join(tracesDir, conductor.concertId, 'movements', 'run', 'attempt-0', 'metadata.json'),
        'utf-8',
      ),
    );
    expect(meta.status).toBe('rejected');
  });

  it('defaults to 0 -> success, otherwise failure, and surfaces the first stderr line', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.stderr.write("boom\\nsecond\\n"); process.exit(2)'],
        transitions: [
          { to: '__end__', on: 'success' },
          { to: '__fail__', on: 'failure' },
        ],
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].status).toBe('failed');
    expect(history[0].error).toEqual(
      expect.objectContaining({ code: 'EXIT_NONZERO', message: 'boom' }),
    );
  });

  it('parses structured output from stdout when output.mode is structured', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write(JSON.stringify({ branch: "main" }))'],
        output: { mode: 'structured' },
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].structured).toEqual({ branch: 'main' });
  });

  it('normalizes a run output trailing newline when substituted, but not harness output', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'base',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write("main\\n")'],
        transitions: [{ to: 'use', on: 'success' }],
      }),
      movement({
        id: 'use',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '{{context.previousOutputs.base}}'],
        transitions: [{ to: '__end__', on: 'success' }],
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    const history = await store.getMovementHistory(conductor.concertId);
    const use = history.find((h) => h.movementId === 'use')!;
    expect(JSON.parse(use.output)).toEqual(['main']);
  });

  it('expands leading ~/ in argv and cwd but keeps env values literal', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [
          NODE,
          '-e',
          'process.stdout.write(JSON.stringify({ arg: process.argv[1], env: process.env.ORCHESTRON_TEST_ENV, cwd: process.cwd() }))',
          '~/literal-arg',
        ],
        cwd: '~/',
        env: { ORCHESTRON_TEST_ENV: '~/env-not-expanded' },
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    const history = await store.getMovementHistory(conductor.concertId);
    const parsed = JSON.parse(history[0].output) as { arg: string; env: string; cwd: string };
    expect(parsed.arg.startsWith('~/')).toBe(false);
    expect(parsed.arg).toContain('literal-arg');
    expect(parsed.env).toBe('~/env-not-expanded');
    expect(parsed.cwd).toBe(homedir());
  });

  it('streams run_start/run_stdout/run_stderr/run_exit progress events', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(0)'],
      }),
    ]);
    const { hall } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    const events = (await hall.getConcertStream()!.readEvents(conductor.concertId)).filter(
      (e): e is ConcertEvent & { type: 'movement:progress' } => e.type === 'movement:progress',
    );
    const types = events.map((e) => e.progressType);
    expect(types).toContain('run_start');
    expect(types).toContain('run_stdout');
    expect(types).toContain('run_stderr');
    expect(types).toContain('run_exit');
    expect(types.indexOf('run_exit')).toBeGreaterThan(types.indexOf('run_start'));
  });

  it('writes per-attempt stdout/stderr logs and run metadata', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.stdout.write("captured-out"); process.stderr.write("captured-err")'],
      }),
    ]);
    const { hall } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    const attemptDir = join(tracesDir, conductor.concertId, 'movements', 'run', 'attempt-0');
    expect(existsSync(join(attemptDir, 'stdout.log'))).toBe(true);
    expect(readFileSync(join(attemptDir, 'stdout.log'), 'utf-8')).toBe('captured-out');
    expect(readFileSync(join(attemptDir, 'stderr.log'), 'utf-8')).toBe('captured-err');

    const index = JSON.parse(
      readFileSync(join(tracesDir, conductor.concertId, 'movements', 'run', 'index.json'), 'utf-8'),
    );
    expect(index.kind).toBe('run');
    const meta = JSON.parse(readFileSync(join(attemptDir, 'metadata.json'), 'utf-8'));
    expect(meta.kind).toBe('run');
    expect(meta.exitCode).toBe(0);
    expect(meta.command[0]).toBe(NODE);
  });

  it('retries a mapped failure with retryOnFailure and succeeds on the retry', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const marker = join(tracesDir, 'marker');
    const script =
      `const fs=require('fs');const p=${JSON.stringify(marker)};` +
      `if(fs.existsSync(p)){process.exit(0)}else{fs.writeFileSync(p,'1');process.exit(1)}`;
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', script],
        retryOnFailure: true,
        budget: { maxRetries: 2 },
        transitions: [
          { to: '__end__', on: 'success' },
          { to: '__fail__', on: 'failure' },
        ],
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].status).toBe('completed');
    expect(history[0].exitCode).toBe(0);
    expect(evaluator.calls).toBe(0);
  });

  it('resolves a mapped rejection through the rejection transition', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'process.exit(3)'],
        outcomes: { 0: 'success', 3: 'rejection', default: 'failure' },
        transitions: [
          { to: '__end__', on: 'success' },
          { to: '__end__', on: 'rejection' },
          { to: '__fail__', on: 'failure' },
        ],
      }),
    ]);
    const { hall } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const history = (await conductor.getState()).history;
    expect(history[0].status).toBe('rejected');
  });

  it('pins the triage and implement claim exit-code tables', async () => {
    const triageTransitions: Movement['transitions'] = [
      { to: 'assess', on: 'success' },
      { to: '__end__', on: 'rejection' },
      { to: 'fail_cleanup', on: 'failure' },
    ];
    const implementTransitions: Movement['transitions'] = [
      { to: 'assess', on: 'success' },
      { to: 'fail_cleanup', on: 'rejection' },
      { to: 'fail_cleanup', on: 'failure' },
    ];
    const cases: Array<{
      label: string;
      code: number;
      transitions: Movement['transitions'];
      assessed: boolean;
      cleaned: boolean;
      status: 'completed' | 'failed';
    }> = [
      { label: 'triage 0', code: 0, transitions: triageTransitions, assessed: true, cleaned: false, status: 'completed' },
      { label: 'triage 3', code: 3, transitions: triageTransitions, assessed: false, cleaned: false, status: 'completed' },
      { label: 'triage 1', code: 1, transitions: triageTransitions, assessed: false, cleaned: true, status: 'failed' },
      { label: 'triage 2', code: 2, transitions: triageTransitions, assessed: false, cleaned: true, status: 'failed' },
      { label: 'implement 0', code: 0, transitions: implementTransitions, assessed: true, cleaned: false, status: 'completed' },
      { label: 'implement 3', code: 3, transitions: implementTransitions, assessed: false, cleaned: true, status: 'failed' },
      { label: 'implement 1', code: 1, transitions: implementTransitions, assessed: false, cleaned: true, status: 'failed' },
      { label: 'implement 2', code: 2, transitions: implementTransitions, assessed: false, cleaned: true, status: 'failed' },
    ];

    for (const testCase of cases) {
      const evaluator = new SpyEvaluator();
      const tracesDir = tmp();
      const score = runScore([
        movement({
          id: 'claim',
          type: 'run',
          command: [NODE, '-e', `process.exit(${testCase.code})`],
          outcomes: { 0: 'success', 3: 'rejection', default: 'failure' },
          transitions: testCase.transitions,
        }),
        movement({
          id: 'assess',
          type: 'run',
          command: [NODE, '-e', 'process.exit(0)'],
          transitions: [{ to: '__end__', on: 'success' }],
        }),
        movement({
          id: 'fail_cleanup',
          type: 'run',
          command: [NODE, '-e', 'process.exit(0)'],
          transitions: [{ to: '__fail__', on: 'any' }],
        }),
      ]);
      const { hall, store } = makeHall(score, evaluator, tracesDir);
      const conductor = await hall.createConcert('run-score');
      await conductor.start();
      const ids = (await store.getMovementHistory(conductor.concertId)).map((h) => h.movementId);
      expect(ids.includes('assess'), testCase.label).toBe(testCase.assessed);
      expect(ids.includes('fail_cleanup'), testCase.label).toBe(testCase.cleaned);
      expect(conductor.status, testCase.label).toBe(testCase.status);
    }
  });

  it('resolves an aborted run as a technical failure without mapped outcomes', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore([
      movement({
        id: 'run',
        type: 'run',
        command: [NODE, '-e', 'setTimeout(()=>process.exit(0), 60000)'],
        budget: { timeoutMs: 250 },
        transitions: [
          { to: '__end__', on: 'success' },
          { to: '__fail__', on: 'failure' },
        ],
      }),
    ]);
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const history = await store.getMovementHistory(conductor.concertId);
    expect(history[0].status).toBe('failed');
    expect(history[0].error?.code).toBe('MOVEMENT_ABORTED');
    expect(evaluator.calls).toBe(0);
  });

  it('ignores the program-level persistSession/reuseSession option for run movements', async () => {
    const evaluator = new SpyEvaluator();
    const tracesDir = tmp();
    const score = runScore(
      [movement({ id: 'run', type: 'run', command: [NODE, '-e', 'process.exit(0)'] })],
      { program: { persistSession: true } },
    );
    const { hall, store } = makeHall(score, evaluator, tracesDir);
    const conductor = await hall.createConcert('run-score');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    // A run step never resolves, creates, or reuses a harness session, so the
    // program-level session option is inert for it: the only trace row is the
    // run attempt itself, with no pool key / SDK session.
    const traces = await store.getSessionTracesForConcert(conductor.concertId);
    expect(traces).toHaveLength(1);
    expect(traces[0].harness).toBe('run');
    expect(traces[0].sessionKey).toBeUndefined();
    expect(evaluator.calls).toBe(0);
  });
});
