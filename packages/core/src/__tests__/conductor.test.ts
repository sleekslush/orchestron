import { describe, it, expect } from 'vitest';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Score } from '../types/score.js';

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
