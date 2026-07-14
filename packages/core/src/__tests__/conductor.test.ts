import { describe, it, expect } from 'vitest';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { Conductor } from '../conductor/conductor.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Score, MovementID } from '../types/score.js';
import type { Concert, ConcertID } from '../types/concert.js';

class CapturingFakeHarnessAdapter extends FakeHarnessAdapter {
  prompts: { movementId?: string; prompt: string }[] = [];
  async execute(prompt: string, context: any, options?: any) {
    this.prompts.push({ movementId: options?.movementId, prompt });
    return super.execute(prompt, context, options);
  }
}

function linearScore(): Score {
  return {
    id: 'linear-test',
    name: 'Linear Test',
    description: 'A→B→end',
    version: '1.0.0',
    startMovement: 'step_a',
    movements: [
      {
        id: 'step_a',
        name: 'Step A',
        section: 'default',
        description: 'First step',
        harness: 'fake',
        prompt: 'Do step A',
        goal: { description: 'Step A complete', strategy: 'llm_judge' },
        transitions: [{ to: 'step_b', on: 'success' }],
      },
      {
        id: 'step_b',
        name: 'Step B',
        section: 'default',
        description: 'Second step',
        harness: 'fake',
        prompt: 'Do step B',
        goal: { description: 'Step B complete', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      },
    ],
    program: {},
  };
}

it('completes linear workflow', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(linearScore());
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'output', summary: 'summary', usage: { spend: 10, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('linear-test');
  await conductor.start();
  expect(conductor.status).toBe('completed');
});

it('persists state', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(linearScore());
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'output', summary: 'summary', usage: { spend: 10, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('linear-test');
  await conductor.start();
  const stored = await store.getConcert(conductor.concertId);
  expect(stored!.usage.spend).toBe(20);
});

it('constraint breach', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register({
    id: 'constrained', name: 'Constrained', description: 'spend limit', version: '1.0.0',
    startMovement: 'a',
    movements: [
      { id: 'a', name: 'A', section: 'x', description: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: 'b', on: 'success' as const }] },
      { id: 'b', name: 'B', section: 'x', description: 'x', harness: 'fake', prompt: 'B',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: '__end__', on: 'success' as const }] },
    ],
    program: { maxSpendDollars: 1.5 },
  });
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'o', summary: 's', usage: { spend: 1_000_000, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('constrained');
  await conductor.start();
  expect(conductor.status).toBe('failed');
});

it('movement spend limit breach', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register({
    id: 'movement-constrained', name: 'Movement Constrained', description: 'movement spend limit', version: '1.0.0',
    startMovement: 'a',
    movements: [
      { id: 'a', name: 'A', section: 'x', description: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: '__end__', on: 'success' as const }],
        budget: { maxSpendDollars: 0.5 } },
    ],
    program: {},
  });
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'o', summary: 's', usage: { spend: 600_000, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('movement-constrained');
  await conductor.start();
  expect(conductor.status).toBe('failed');
  const events = await store.getEvents(conductor.concertId, { types: ['constraint:breached'] });
  expect(events).toHaveLength(1);
  expect(events[0].constraint).toBe('maxSpendDollars');
  expect(events[0].limit).toBe(0.5);
  expect(events[0].actual).toBe(0.6);
});

it('missing adapter', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(linearScore());
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map(),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('linear-test');
  await conductor.start();
  expect(conductor.status).toBe('failed');
});

it('retry loop', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register({
    id: 'loop', name: 'Loop', description: 'retry', version: '1.0.0',
    startMovement: 'a',
    movements: [
      { id: 'a', name: 'A', section: 'x', description: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: 'b', on: 'success' }, { to: '__fail__', on: 'failure' }] },
      { id: 'b', name: 'B', section: 'x', description: 'x', harness: 'fake', prompt: 'B',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: 'a', on: 'failure' }, { to: '__end__', on: 'success' }] },
    ],
    program: { maxMovements: 10 },
  });
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({
      perMovement: {
        a: { achieved: true, confidence: 1, summary: 'ok', evidence: '' },
        b: { achieved: false, confidence: 0, summary: 'fail', evidence: '' },
      },
    }),
  });
  const conductor = await hall.createConcert('loop');
  await conductor.start();
  expect(conductor.status).toBe('failed');
});

it('structured output', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register({
    id: 'struct', name: 'Struct', description: 'x', version: '1.0.0',
    startMovement: 'plan',
    movements: [{
      id: 'plan', name: 'Plan', section: 'x', description: 'x',
      harness: 'fake', prompt: 'P',
      output: { mode: 'structured', schema: { type: 'object', properties: { s: { type: 'array', items: { type: 'string' } } } } },
      goal: { description: 'done', strategy: 'llm_judge' },
      transitions: [{ to: '__end__', on: 'success' }],
    }],
    program: {},
  });
  const adapter = new FakeHarnessAdapter({
    perMovement: { plan: { output: 't', structured: { s: ['a'] }, summary: 'ok', usage: { spend: 5, tokens: 50 } } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('struct');
  await conductor.start();
  expect(conductor.status).toBe('completed');
  expect((await conductor.getState()).history[0].structured?.s).toContain('a');
});

it('sub-scores', async () => {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register({
    id: 'parent', name: 'Parent', description: 'x', version: '1.0.0',
    startMovement: 'p1',
    movements: [{
      id: 'p1', name: 'P1', section: 'x', description: 'x',
      subscore: { scoreId: 'child', contextMapping: { input: 'shared.input' } },
      goal: { description: 'done', strategy: 'llm_judge' },
      transitions: [{ to: '__end__', on: 'success' }],
    }],
    program: {},
  });
  registry.register({
    id: 'child', name: 'Child', description: 'x', version: '1.0.0',
    startMovement: 'c1',
    movements: [{
      id: 'c1', name: 'C1', section: 'x', description: 'x',
      harness: 'fake', prompt: 'Child {{context.input}}',
      goal: { description: 'done', strategy: 'llm_judge' },
      transitions: [{ to: '__end__', on: 'success' }],
    }],
    program: {},
  });
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'child out', summary: 'done', usage: { spend: 5, tokens: 50 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('parent', { initialContext: { input: 'hello' } });
  await conductor.start();
  expect(conductor.status).toBe('completed');
  expect((await conductor.getState()).childConcertIds).toHaveLength(1);
});

// ─── Conductor Lifecycle Tests ───────────────────────────────

describe('Conductor lifecycle', () => {
  it('pauses and resumes a running concert', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'lifecycle', name: 'Lifecycle', version: '1.0.0',
      startMovement: 'slow',
      movements: [{
        id: 'slow', name: 'Slow', section: 'x', harness: 'fake', prompt: 'S',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 200 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('lifecycle');
    const startPromise = conductor.start();

    await new Promise((r) => setTimeout(r, 30));
    expect(conductor.status).toBe('running');

    await conductor.pause();
    expect(conductor.status).toBe('paused');
    const pausedState = await store.getConcert(conductor.concertId);
    expect(pausedState!.status).toBe('paused');

    await conductor.resume();
    expect(conductor.status).toBe('running');

    await startPromise;
    expect(conductor.status).toBe('completed');
  });

  it('cancels a running concert mid-movement', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'cancel-test', name: 'Cancel Test', version: '1.0.0',
      startMovement: 'slow',
      movements: [{
        id: 'slow', name: 'Slow', section: 'x', harness: 'fake', prompt: 'S',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 1000 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('cancel-test');
    const startPromise = conductor.start();

    await new Promise((r) => setTimeout(r, 10));
    await conductor.cancel();

    await startPromise;
    // Cancel during execution causes a HARNESS_TIMEOUT → movement fails → __fail__
    expect(conductor.status).toBe('failed');
    const state = await conductor.getState();
    expect(state.history[0].error?.code).toBe('HARNESS_TIMEOUT');
  });

  it('pause is idempotent', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'idempotent', name: 'Idempotent', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map(),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('idempotent');
    await conductor.pause();
    // Pending → pause is a no-op
    expect(conductor.status).toBe('pending');
  });

  it('resume on non-paused is a no-op', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'noop-resume', name: 'Noop Resume', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map(),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('noop-resume');
    await conductor.resume();
    expect(conductor.status).toBe('pending');
  });
});

// ─── Duration Constraint Tests ───────────────────────────────

describe('Conductor constraints', () => {
  it('fails when duration limit is exceeded', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'duration-limit', name: 'Duration Limit', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: 'b', on: 'success' }],
      }, {
        id: 'b', name: 'B', section: 'x', harness: 'fake', prompt: 'B',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: { maxDurationMs: 50 },
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 100 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('duration-limit');
    await conductor.start();
    expect(conductor.status).toBe('failed');
    const events = await store.getEvents(conductor.concertId);
    expect(events.some((e) => e.type === 'constraint:breached')).toBe(true);
  });

  it('fails when per-section movement limit is exceeded', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'section-movement-limit', name: 'Section Movement Limit', version: '1.0.0',
      startMovement: 'a',
      movements: [
        {
          id: 'a', name: 'A', section: 'execution', harness: 'fake', prompt: 'A',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'b', on: 'success' }],
        },
        {
          id: 'b', name: 'B', section: 'execution', harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {
        maxMovements: 10,
        perSection: { execution: { maxMovements: 1 } },
      },
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('section-movement-limit');
    await conductor.start();
    expect(conductor.status).toBe('failed');
    const events = await store.getEvents(conductor.concertId);
    expect(events.some((e) => e.type === 'constraint:breached')).toBe(true);
  });

  it('fails when per-section spend limit is exceeded', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'section-spend-limit', name: 'Section Spend Limit', version: '1.0.0',
      startMovement: 'a',
      movements: [
        {
          id: 'a', name: 'A', section: 'execution', harness: 'fake', prompt: 'A',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'b', on: 'success' }],
        },
        {
          id: 'b', name: 'B', section: 'execution', harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {
        maxSpendDollars: 5,
        perSection: { execution: { maxSpendDollars: 0.5 } },
      },
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 600_000, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('section-spend-limit');
    await conductor.start();
    expect(conductor.status).toBe('failed');
    const events = await store.getEvents(conductor.concertId);
    expect(events.some((e) => e.type === 'constraint:breached')).toBe(true);
  });
});

// ─── Movement Progress & Timeout Tests ───────────────────────

describe('Conductor movement progress', () => {
  it('pushes movement:progress events from the adapter', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'progress-test', name: 'Progress Test', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'o',
        summary: 's',
        usage: { spend: 10, tokens: 100 },
        delayMs: 100,
        progressUpdates: [
          { atMs: 25, update: { type: 'tool_execution_start', toolName: 'git_status' } },
          { atMs: 75, update: { type: 'tool_execution_end', toolName: 'git_status', isError: false } },
        ],
      },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('progress-test');
    await conductor.start();
    expect(conductor.status).toBe('completed');
    const progressEvents = await store.getEvents(conductor.concertId, { types: ['movement:progress'] });
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.some((e) => e.type === 'movement:progress' && (e as any).progressType === 'tool_execution_start')).toBe(true);
    expect(progressEvents.some((e) => e.type === 'movement:progress' && (e as any).progressType === 'tool_execution_end')).toBe(true);
  });

  it('aborts a movement that exceeds its timeout', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'timeout-test', name: 'Timeout Test', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        budget: { timeoutMs: 100 },
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 500 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('timeout-test');
    await conductor.start();
    expect(conductor.status).toBe('failed');
    const state = await conductor.getState();
    expect(state.history[0].error?.code).toBe('HARNESS_TIMEOUT');
  });

  it('falls back to program.maxDurationMs as movement timeout when no budget is set', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'max-duration-timeout', name: 'Max Duration Timeout', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: { maxDurationMs: 100 },
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 500 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('max-duration-timeout');
    await conductor.start();
    expect(conductor.status).toBe('failed');
    const state = await conductor.getState();
    expect(state.history[0].error?.code).toBe('HARNESS_TIMEOUT');
  });
});

// ─── Dual Prompt Tests ─────────────────────────────────────

describe('Dual prompt selection', () => {
  function dualPromptScore(): Score {
    return {
      id: 'dual-prompt',
      name: 'Dual Prompt',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-prompt', subsequent: 'subsequent-prompt' },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'step_b', on: 'success' }],
        },
        {
          id: 'step_b', name: 'B', section: 'x', harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
  }

  it('selects initial prompt on first visit', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(dualPromptScore());
    const adapter = new CapturingFakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('dual-prompt');
    await conductor.start();
    const stepAPrompts = adapter.prompts.filter((p) => p.movementId === 'step_a');
    expect(stepAPrompts).toHaveLength(1);
    expect(stepAPrompts[0].prompt).toBe('initial-prompt');
  });

  it('selects subsequent prompt on revisit via loop', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'loop-dual',
      name: 'Loop Dual',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-a', subsequent: 'subsequent-a' },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'step_b', on: 'success' }],
        },
        {
          id: 'step_b', name: 'B', section: 'x', harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'step_a', on: 'failure' }, { to: '__end__', on: 'success' }],
        },
      ],
      program: { maxMovements: 5 },
    });
    const adapter = new CapturingFakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({
        perMovement: {
          step_a: { achieved: true, confidence: 1, summary: 'ok', evidence: '' },
          step_b: { achieved: false, confidence: 0, summary: 'fail', evidence: '' },
        },
      }),
    });
    const conductor = await hall.createConcert('loop-dual');
    await conductor.start();
    const stepAPrompts = adapter.prompts.filter((p) => p.movementId === 'step_a');
    expect(stepAPrompts).toHaveLength(3);
    expect(stepAPrompts[0].prompt).toBe('initial-a');
    expect(stepAPrompts[1].prompt).toBe('subsequent-a');
    expect(stepAPrompts[2].prompt).toBe('subsequent-a');
  });

  it('selects subsequent prompt during retryOnFailure retries', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'retry-dual',
      name: 'Retry Dual',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-a', subsequent: 'subsequent-a' },
          goal: { description: 'done', strategy: 'llm_judge' },
          retryOnFailure: true,
          budget: { maxRetries: 2 },
          transitions: [{ to: '__end__', on: 'success' }, { to: '__fail__', on: 'failure' }],
        },
      ],
      program: {},
    });
    const adapter = new (class extends CapturingFakeHarnessAdapter {
      failCount = 0;
      async execute(prompt: string, context: any, options?: any) {
        if (options?.movementId === 'step_a' && this.failCount < 2) {
          this.failCount++;
          this.prompts.push({ movementId: options?.movementId, prompt });
          throw new Error('Fake failure');
        }
        return super.execute(prompt, context, options);
      }
    })({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('retry-dual');
    await conductor.start();
    expect(conductor.status).toBe('completed');
    const stepAPrompts = adapter.prompts.filter((p) => p.movementId === 'step_a');
    expect(stepAPrompts).toHaveLength(3);
    expect(stepAPrompts[0].prompt).toBe('initial-a');
    expect(stepAPrompts[1].prompt).toBe('subsequent-a');
    expect(stepAPrompts[2].prompt).toBe('subsequent-a');
  });

  it('seeds visit counts from history during recover', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'recover-dual',
      name: 'Recover Dual',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-a', subsequent: 'subsequent-a' },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'step_b', on: 'success' }],
        },
        {
          id: 'step_b', name: 'B', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-b', subsequent: 'subsequent-b' },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }, { to: 'step_b', on: 'failure' }],
        },
      ],
      program: {},
    });
    const adapter = new CapturingFakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('recover-dual');
    await conductor.start();
    expect(conductor.status).toBe('completed');

    // Simulate crash on step_b by resetting currentMovement and status
    await store.updateConcert({ id: conductor.concertId, status: 'running', currentMovement: 'step_b' });

    const recovered = await store.getConcert(conductor.concertId).then((stored) => {
      return new Conductor(
        stored!, registry.get('recover-dual'), store, hall,
        new Map([['fake', adapter]]), new FakeEvaluator({ alwaysSucceed: true }),
      );
    });
    await recovered.recover();
    expect(recovered.status).toBe('completed');

    const stepBPrompts = adapter.prompts.filter((p) => p.movementId === 'step_b');
    expect(stepBPrompts).toHaveLength(2);
    expect(stepBPrompts[0].prompt).toBe('initial-b');
    expect(stepBPrompts[1].prompt).toBe('subsequent-b');
  });

  it('seeds visit counts from history during resume', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'resume-dual',
      name: 'Resume Dual',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake',
          prompt: { initial: 'initial-a', subsequent: 'subsequent-a' },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    });
    const adapter = new CapturingFakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 }, delayMs: 200 },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const conductor = await hall.createConcert('resume-dual');
    const startPromise = conductor.start();
    await new Promise((r) => setTimeout(r, 50));
    await conductor.pause();
    expect(conductor.status).toBe('paused');

    await conductor.resume();
    await startPromise;
    expect(conductor.status).toBe('completed');

    const stepAPrompts = adapter.prompts.filter((p) => p.movementId === 'step_a');
    expect(stepAPrompts).toHaveLength(1);
    expect(stepAPrompts[0].prompt).toBe('initial-a');
  });
});

// ─── ConcertHall Tests ───────────────────────────────────────

describe('ConcertHall', () => {
  it('waitForConcert resolves when concert completes', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'quick', name: 'Quick', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('quick');
    const resultPromise = hall.waitForConcert(conductor.concertId);
    conductor.start().catch(() => {});
    const concert = await resultPromise;
    expect(concert.status).toBe('completed');
  });

  it('waitForConcert throws for unknown concert', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    const hall = new ConcertHall({ store, scoreRegistry: registry, adapters: new Map(), evaluator: new FakeEvaluator({ alwaysSucceed: true }) });
    await expect(hall.waitForConcert('nonexistent')).rejects.toThrow('not found');
  });

  it('lists concerts with combined filters', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'filter-score', name: 'Filter', version: '1.0.0',
      startMovement: 'a',
      movements: [{
        id: 'a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const c1 = await hall.createConcert('filter-score');
    await c1.start();
    const c2 = await hall.createConcert('filter-score');
    await c2.start();

    const running = hall.list({ status: 'completed' });
    expect(running).toHaveLength(2);

    const limited = hall.list({ limit: 1 });
    expect(limited).toHaveLength(1);

    const withStatus = hall.list({ status: 'completed', limit: 1 });
    expect(withStatus).toHaveLength(1);
  });

  it('getChildConcerts returns children', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'parent', name: 'Parent', version: '1.0.0',
      startMovement: 'p',
      movements: [{
        id: 'p', name: 'P', section: 'x',
        subscore: { scoreId: 'child', contextMapping: {} },
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    registry.register({
      id: 'child', name: 'Child', version: '1.0.0',
      startMovement: 'c',
      movements: [{
        id: 'c', name: 'C', section: 'x', harness: 'fake', prompt: 'C',
        goal: { description: 'done', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }],
      }],
      program: {},
    });
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('parent');
    await conductor.start();

    const children = hall.getChildConcerts(conductor.concertId);
    expect(children).toHaveLength(1);
    const childConductor = hall.getConcert(children[0]);
    expect(childConductor).toBeDefined();
  });
});

// ─── FakeHarnessAdapter Direct Tests ─────────────────────────

describe('FakeHarnessAdapter', () => {
  it('returns default output with no config', async () => {
    const adapter = new FakeHarnessAdapter({});
    const result = await adapter.execute('prompt', { shared: {} });
    expect(result.output).toBe('Default fake output');
    expect(result.summary).toBe('Executed successfully');
    expect(result.usage.spend).toBe(10);
  });

  it('uses per-movement config when movementId matches', async () => {
    const adapter = new FakeHarnessAdapter({
      perMovement: {
        step_a: { output: 'Step A output', summary: 'Step A done', usage: { spend: 5, tokens: 50 } },
      },
    });
    const result = await adapter.execute('p', { shared: {} }, { movementId: 'step_a' });
    expect(result.output).toBe('Step A output');
    expect(result.usage.spend).toBe(5);
  });

  it('falls back to default when movementId has no per-movement config', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'default', summary: 's', usage: { spend: 1, tokens: 10 } },
      perMovement: { other: { output: 'other' } },
    });
    const result = await adapter.execute('p', { shared: {} }, { movementId: 'unknown' });
    expect(result.output).toBe('default');
  });

  it('throws HarnessError when fail is true', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { fail: true },
    });
    await expect(adapter.execute('p', { shared: {} })).rejects.toThrow('Fake harness failure');
  });

  it('respects delayMs', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { delayMs: 50 },
    });
    const start = Date.now();
    await adapter.execute('p', { shared: {} });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('respects globalDelayMs', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o' },
      globalDelayMs: 30,
    });
    const start = Date.now();
    await adapter.execute('p', { shared: {} });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('fills synthetic structured data when output mode is structured', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'raw' },
    });
    const result = await adapter.execute('p', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });
    expect(result.structured).toEqual({ parsed: true, from: 'fake-harness' });
  });

  it('uses provided structured data when present', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'raw', structured: { key: 'val' } },
    });
    const result = await adapter.execute('p', { shared: {} }, {
      output: { mode: 'structured' },
    });
    expect(result.structured).toEqual({ key: 'val' });
  });
});

// ─── FakeEvaluator Direct Tests ──────────────────────────────

describe('FakeEvaluator', () => {
  it('alwaysSucceed returns achieved: true', async () => {
    const evaluator = new FakeEvaluator({ alwaysSucceed: true });
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} },
    );
    expect(result.achieved).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it('perMovement returns configured evaluation for matching movement', async () => {
    const evaluator = new FakeEvaluator({
      perMovement: {
        step_x: { achieved: false, confidence: 0, summary: 'custom fail', evidence: 'nope' },
      },
    });
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} }, 'step_x',
    );
    expect(result.achieved).toBe(false);
    expect(result.summary).toBe('custom fail');
    expect(result.evidence).toBe('nope');
  });

  it('failOn returns failed evaluation for listed movements', async () => {
    const evaluator = new FakeEvaluator({ failOn: ['bad-step'] });
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} }, 'bad-step',
    );
    expect(result.achieved).toBe(false);
    expect(result.summary).toBe('Configured to fail');
  });

  it('defaultResult returns configured default', async () => {
    const evaluator = new FakeEvaluator({
      defaultResult: { achieved: false, confidence: 0.5, summary: 'maybe' },
    });
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} }, 'unknown',
    );
    expect(result.achieved).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  it('empty config returns default true', async () => {
    const evaluator = new FakeEvaluator();
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} },
    );
    expect(result.achieved).toBe(true);
    expect(result.summary).toBe('Goal met (default)');
  });

  it('alwaysSucceed takes priority over perMovement', async () => {
    const evaluator = new FakeEvaluator({
      alwaysSucceed: true,
      perMovement: {
        failer: { achieved: false, confidence: 0, summary: 'nope' },
      },
    });
    const result = await evaluator.evaluate(
      { description: 'x', strategy: 'llm_judge' }, '', { shared: {} }, 'failer',
    );
    expect(result.achieved).toBe(true);
    expect(result.summary).toBe('Always succeeds');
  });
});

// ─── Crash Recovery Tests ────────────────────────────────────

describe('Conductor.recover()', () => {
  function recoveryScore(): Score {
    return {
      id: 'recovery-test',
      name: 'Recovery Test',
      description: 'step_a failure -> step_b, step_b -> end',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'step_b', on: 'success' }, { to: 'step_b', on: 'failure' }],
        },
        {
          id: 'step_b', name: 'B', section: 'x', harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
  }

  function failScore(): Score {
    return {
      id: 'recovery-fail',
      name: 'Recovery Fail',
      description: 'step_a failure -> __fail__',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', harness: 'fake', prompt: 'A',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }, { to: '__fail__', on: 'failure' }],
        },
      ],
      program: {},
    };
  }

  function makeHall(score: Score) {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(score);
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 10, tokens: 100 } },
    });
    const evaluator = new FakeEvaluator({ alwaysSucceed: true });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]), evaluator,
    });
    return { store, registry, adapter, evaluator, hall };
  }

  async function simulateCrash(
    store: SqliteLoge,
    currentMovement: MovementID | null,
  ): Promise<ConcertID> {
    const concerts = await store.listConcerts();
    const concertId = concerts[0].id;
    await store.updateConcert({ id: concertId, status: 'running', currentMovement });
    return concertId;
  }

  function buildRecoveredConductor(
    store: SqliteLoge,
    score: Score,
    hall: ConcertHall,
    adapter: FakeHarnessAdapter,
    evaluator: FakeEvaluator,
    concertId: ConcertID,
  ): Promise<Conductor> {
    return store.getConcert(concertId).then((stored) => {
      return new Conductor(
        stored!, score, store, hall,
        new Map([['fake', adapter]]), evaluator,
      );
    });
  }

  it('marks in-progress movement as STATE_CORRUPTION and continues via failure transition', async () => {
    const score = recoveryScore();
    const { store, registry, adapter, evaluator, hall } = makeHall(score);
    await hall.createConcert('recovery-test');
    const concertId = await simulateCrash(store, 'step_a');
    const recovered = await buildRecoveredConductor(store, score, hall, adapter, evaluator, concertId);

    await recovered.recover();

    expect(recovered.status).toBe('completed');
    const state = await recovered.getState();
    expect(state.history).toHaveLength(2);
    expect(state.history[0].movementId).toBe('step_a');
    expect(state.history[0].status).toBe('failed');
    expect(state.history[0].error?.code).toBe('STATE_CORRUPTION');
    expect(state.history[1].movementId).toBe('step_b');
    expect(state.history[1].status).toBe('completed');
  });

  it('terminates at __fail__ when failure transition leads to __fail__', async () => {
    const score = failScore();
    const { store, registry, adapter, evaluator, hall } = makeHall(score);
    await hall.createConcert('recovery-fail');
    const concertId = await simulateCrash(store, 'step_a');
    const recovered = await buildRecoveredConductor(store, score, hall, adapter, evaluator, concertId);

    await recovered.recover();

    expect(recovered.status).toBe('failed');
    const state = await recovered.getState();
    expect(state.history).toHaveLength(1);
    expect(state.history[0].error?.code).toBe('STATE_CORRUPTION');
  });

  it('starts fresh when no currentMovement is set', async () => {
    const score = recoveryScore();
    const { store, registry, adapter, evaluator, hall } = makeHall(score);
    await hall.createConcert('recovery-test');
    const concertId = await simulateCrash(store, null);
    const recovered = await buildRecoveredConductor(store, score, hall, adapter, evaluator, concertId);

    await recovered.recover();

    expect(recovered.status).toBe('completed');
    const state = await recovered.getState();
    expect(state.history).toHaveLength(2);
    expect(state.history[0].movementId).toBe('step_a');
    expect(state.history[0].status).toBe('completed');
    expect(state.history[1].movementId).toBe('step_b');
    expect(state.history[1].status).toBe('completed');
  });

  it('throws when concert status is not running or paused', async () => {
    const { store, registry, adapter, evaluator, hall } = makeHall(recoveryScore());
    const conductor = await hall.createConcert('recovery-test');
    await expect(conductor.recover()).rejects.toThrow(/status is pending/);
  });

  it('rehydrate creates conductors and recovers running concerts', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    const score = failScore();
    registry.register(score);

    // Create concert directly in store with crash state
    const concert: Concert = {
      id: 'crashed-1', scoreId: 'recovery-fail', status: 'running',
      startedAt: new Date(), currentMovement: 'step_a', history: [],
      context: { shared: {} }, usage: {}, triggeredBy: 'cli',
      childConcertIds: [],
    };
    await store.saveConcert(concert, '');

    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 10, tokens: 100 } },
    });
    const evaluator = new FakeEvaluator({ alwaysSucceed: true });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]), evaluator,
    });

    await hall.rehydrate();

    expect(hall.getConcert('crashed-1')).toBeDefined();

    // Poll for async recovery to finish
    for (let i = 0; i < 20; i++) {
      const s = await store.getConcert('crashed-1');
      if (s?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const state = await store.getConcert('crashed-1');
    expect(state!.status).toBe('failed');
    expect(state!.history).toHaveLength(1);
    expect(state!.history[0].error?.code).toBe('STATE_CORRUPTION');
  });

  it('paused concerts are not recovered by rehydrate', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    const score = failScore();
    registry.register(score);

    const concert: Concert = {
      id: 'paused-1', scoreId: 'recovery-fail', status: 'paused',
      startedAt: new Date(), currentMovement: null, history: [],
      context: { shared: {} }, usage: {}, triggeredBy: 'cli',
      childConcertIds: [],
    };
    await store.saveConcert(concert, '');

    const adapter = new FakeHarnessAdapter({});
    const evaluator = new FakeEvaluator({ alwaysSucceed: true });
    const hall = new ConcertHall({
      store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]), evaluator,
    });

    await hall.rehydrate();
    await new Promise((r) => setTimeout(r, 50));

    const state = await store.getConcert('paused-1');
    expect(state!.status).toBe('paused');
  });

  it('uses defaultHarness when movement.harness is omitted', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    const score: Score = {
      id: 'default-harness-test',
      name: 'Default Harness Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'default',
          prompt: 'Do step 1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    registry.register(score);

    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'ok',
        summary: 'ok',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'fake',
    });

    const conductor = await hall.createConcert('default-harness-test');
    await conductor.start();
    expect(conductor.status).toBe('completed');
  });

  it('movement.harness overrides defaultHarness', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();

    const primaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'primary',
        summary: 'primary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });
    const secondaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'secondary',
        summary: 'secondary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });

    const score: Score = {
      id: 'override-test',
      name: 'Override Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'default',
          harness: 'secondary',
          prompt: 'Do step 1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    registry.register(score);

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([
        ['primary', primaryAdapter],
        ['secondary', secondaryAdapter],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'primary',
    });

    const conductor = await hall.createConcert('override-test');
    await conductor.start();
    expect(conductor.status).toBe('completed');
    expect(secondaryAdapter.prompts).toHaveLength(1);
    expect(primaryAdapter.prompts).toHaveLength(0);
  });

  it('score.evaluator.harness overrides defaultHarness for evaluation', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();

    const evalAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: '{"achieved":true,"confidence":1,"summary":"Goal achieved"}',
        summary: 'evaluated',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });
    const moveAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: { output: 'moved', summary: 'moved', usage: { spend: 1, tokens: 1 } },
    });

    const score: Score = {
      id: 'eval-override-test',
      name: 'Eval Override Test',
      version: '1.0.0',
      startMovement: 'step1',
      evaluator: { harness: 'eval', model: 'test-model' },
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'default',
          harness: 'move',
          prompt: 'Do step 1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    registry.register(score);

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([
        ['move', moveAdapter],
        ['eval', evalAdapter],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: false }), // global evaluator should NOT be used
      defaultHarness: 'move',
    });

    const conductor = await hall.createConcert('eval-override-test');
    await conductor.start();
    expect(conductor.status).toBe('completed');
    expect(evalAdapter.prompts.length).toBeGreaterThan(0);
    expect(moveAdapter.prompts).toHaveLength(1);
  });

  it('explicit StartOptions.harness overrides defaultHarness for movements', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();

    const primaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'primary',
        summary: 'primary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });
    const secondaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'secondary',
        summary: 'secondary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });

    const score: Score = {
      id: 'explicit-harness-test',
      name: 'Explicit Harness Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'default',
          prompt: 'Do step 1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    registry.register(score);

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([
        ['primary', primaryAdapter],
        ['secondary', secondaryAdapter],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'primary',
    });

    const conductor = await hall.createConcert('explicit-harness-test', { harness: 'secondary' });
    await conductor.start();
    expect(conductor.status).toBe('completed');
    expect(secondaryAdapter.prompts.length).toBeGreaterThanOrEqual(1);
    expect(primaryAdapter.prompts).toHaveLength(0);
  });

  it('persists explicitHarness across loadConcert', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();

    const primaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'primary',
        summary: 'primary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });
    const secondaryAdapter = new CapturingFakeHarnessAdapter({
      defaultResponse: {
        output: 'secondary',
        summary: 'secondary',
        usage: { spend: 1, tokens: 1 },
        structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
      },
    });

    const score: Score = {
      id: 'persist-harness-test',
      name: 'Persist Harness Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'default',
          prompt: 'Do step 1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
    registry.register(score);

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([
        ['primary', primaryAdapter],
        ['secondary', secondaryAdapter],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'primary',
    });

    const conductor = await hall.createConcert('persist-harness-test', { harness: 'secondary' });
    const concertId = conductor.concertId;

    // Simulate process restart by creating a new hall and loading the concert
    const hall2 = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([
        ['primary', primaryAdapter],
        ['secondary', secondaryAdapter],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'primary',
    });

    const loaded = await hall2.loadConcert(concertId);
    expect(loaded).toBeDefined();
    await loaded!.start();
    expect(loaded!.status).toBe('completed');
    expect(secondaryAdapter.prompts.length).toBeGreaterThanOrEqual(1);
  });
});
