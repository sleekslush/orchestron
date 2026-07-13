import { describe, it, expect, vi } from 'vitest';
import {
  FakeEvaluator,
  FakeHarnessAdapter,
  ScoreRegistry,
  SqliteLoge,
  ConcertHall,
} from '@orchestron/core';
import type { Score } from '@orchestron/core';

// Import the plugin and common functions to verify they're exported correctly
import OrchestronPlugin from '../index.js';
import {
  createOrchestron,
  startConcert,
  getConcertStatus,
  listConcerts,
  pauseConcert,
  cancelConcert,
  waitForConcert,
  listScores,
  getScore,
  createScore,
  editScore,
} from '@orchestron/plugin-common';

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

async function createTestOrchestron(score: Score) {
  return createOrchestron({
    storePath: ':memory:',
    scoresDirs: [],
    adapters: new Map([
      [
        'fake',
        new FakeHarnessAdapter({
          defaultResponse: {
            output: 'output',
            summary: 'summary',
            usage: { spend: 10, tokens: 100 },
          },
        }),
      ],
    ]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  }).then((orchestron) => {
    orchestron.registry.register(score);
    return orchestron;
  });
}

describe('plugin-opencode tool functions', () => {
  it('plugin is a valid Plugin function', () => {
    expect(OrchestronPlugin).toBeDefined();
    expect(typeof OrchestronPlugin).toBe('function');
  });

  it('starts a concert and returns initial status', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const result = await startConcert(orchestron, { scoreId: 'linear-test' });

    expect(result.scoreId).toBe('linear-test');
    expect(result.concertId).toBeDefined();
    expect(result.status).toMatch(/pending|running/);
    expect(result.startedAt).toBeDefined();
  });

  it('gets concert status and movement history', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });

    const conductor = orchestron.hall.getConcert(concertId);
    if (conductor) {
      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          const state = await conductor.getState();
          if (state.status !== 'running' && state.status !== 'pending') {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
    }

    const status = await getConcertStatus(orchestron, { concertId });

    expect(status.concertId).toBe(concertId);
    expect(status.scoreId).toBe('linear-test');
    expect(status.status).toBe('completed');
    expect(status.movements).toHaveLength(2);
    expect(status.movements[0].movementId).toBe('step_a');
    expect(status.movements[1].movementId).toBe('step_b');
    expect(status.usage.spend).toBe(0.00002);
  });

  it('lists concerts with filters', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });

    const conductor = orchestron.hall.getConcert(concertId);
    if (conductor) {
      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          const state = await conductor.getState();
          if (state.status !== 'running' && state.status !== 'pending') {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
    }

    const result = await listConcerts(orchestron, { status: 'completed' });
    expect(result.concerts).toHaveLength(1);
    expect(result.concerts[0].concertId).toBe(concertId);
  });

  it('lists registered scores', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const result = await listScores(orchestron);

    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].id).toBe('linear-test');
    expect(result.scores[0].movements).toEqual(['step_a', 'step_b']);
  });

  it('throws when starting an unknown score', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    await expect(startConcert(orchestron, { scoreId: 'unknown' })).rejects.toThrow();
  });

  it('throws when getting status for an unknown concert', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    await expect(getConcertStatus(orchestron, { concertId: 'no-such-id' })).rejects.toThrow(
      "Concert 'no-such-id' not found",
    );
  });

  it('pauses a running concert', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'o',
        summary: 's',
        usage: { spend: 10, tokens: 100 },
        delayMs: 500,
      },
    });
    const registry = new ScoreRegistry();
    registry.register(linearScore());
    const store = new SqliteLoge(':memory:');
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const { concertId } = await startConcert(
      { store, registry, hall, scoresDirs: [] },
      { scoreId: 'linear-test' },
    );
    await new Promise((r) => setTimeout(r, 50));

    const result = await pauseConcert(
      { store, registry, hall, scoresDirs: [] },
      { concertId },
    );
    expect(result.status).toBe('paused');

    const stored = await store.getConcert(concertId);
    expect(stored!.status).toBe('paused');
  });

  it('cancels a running concert', async () => {
    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'o',
        summary: 's',
        usage: { spend: 10, tokens: 100 },
        delayMs: 500,
      },
    });
    const registry = new ScoreRegistry();
    registry.register(linearScore());
    const store = new SqliteLoge(':memory:');
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });
    const orchestron = { store, registry, hall, scoresDirs: [] };

    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });

    await new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        const state = await store.getConcert(concertId);
        if (state?.status === 'running') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    await cancelConcert(orchestron, { concertId });

    const result = await new Promise<{ concertId: string; status: string }>((resolve) => {
      const interval = setInterval(async () => {
        const state = await store.getConcert(concertId);
        if (state && state.status !== 'running' && state.status !== 'pending') {
          clearInterval(interval);
          resolve({ concertId: state.id, status: state.status });
        }
      }, 50);
    });

    expect(['cancelled', 'failed']).toContain(result.status);
  });

  it('waits for a completed concert', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });

    const result = await waitForConcert(orchestron, { concertId });
    expect(result.concertId).toBe(concertId);
    expect(result.status).toBe('completed');
    expect(result.movements).toHaveLength(2);
  });

  it('creates a score in memory', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const yaml = `id: new-score
name: "New Score"
version: "1.0.0"
startMovement: step
movements:
  - id: step
    name: Step
    section: default
    harness: fake
    prompt: Do it
    goal:
      description: done
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
program: {}
`;

    const result = await createScore(orchestron, {
      scoreId: 'new-score',
      yaml,
      persist: false,
    });
    expect(result.valid).toBe(true);
    expect(result.persisted).toBe(false);

    const list = await listScores(orchestron);
    expect(list.scores.find((s) => s.id === 'new-score')).toBeDefined();
  });

  it('edits an in-memory score', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const newYaml = `id: linear-test
name: "Edited"
version: "2.0.0"
startMovement: step
movements:
  - id: step
    name: Step
    section: default
    harness: fake
    prompt: Do it
    goal:
      description: done
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
program: {}
`;

    const result = await editScore(orchestron, {
      scoreId: 'linear-test',
      yaml: newYaml,
      persist: false,
    });
    expect(result.valid).toBe(true);

    const score = orchestron.registry.get('linear-test');
    expect(score.version).toBe('2.0.0');
  });

  it('gets a score by id', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const result = await getScore(orchestron, { scoreId: 'linear-test' });
    expect(result.scoreId).toBe('linear-test');
    expect(result.persisted).toBe(false);
  });
});
