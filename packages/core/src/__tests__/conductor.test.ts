import { describe, it, expect } from 'vitest';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { Conductor } from '../conductor/conductor.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Score, MovementID } from '../types/score.js';
import type { Concert, ConcertID } from '../types/concert.js';

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
    program: { maxSpend: 15 },
  });
  const adapter = new FakeHarnessAdapter({
    defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
  });
  const hall = new ConcertHall({
    store, scoreRegistry: registry, adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });
  const conductor = await hall.createConcert('constrained');
  await conductor.start();
  expect(conductor.status).toBe('failed');
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
    await store.saveConcert(concert);

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
    await store.saveConcert(concert);

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
});
