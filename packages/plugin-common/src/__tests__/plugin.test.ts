import { describe, it, expect, vi } from 'vitest';
import {
  FakeEvaluator,
  FakeHarnessAdapter,
  ScoreRegistry,
  SqliteLoge,
  ConcertHall,
} from '@orchestron/core';
import type { Score } from '@orchestron/core';
import { createOrchestron, type Orchestron } from '../orchestron.js';
import { startConcert } from '../tools/start-concert.js';
import { getConcertStatus } from '../tools/get-status.js';
import { listConcerts } from '../tools/list-concerts.js';
import { pauseConcert } from '../tools/pause-concert.js';
import { cancelConcert } from '../tools/cancel-concert.js';
import { listScores } from '../tools/list-scores.js';
import { waitForConcert } from '../tools/wait-for-concert.js';
import { getScore } from '../tools/get-score.js';
import { createScore } from '../tools/create-score.js';
import { editScore } from '../tools/edit-score.js';
import { toUsageView } from '../util.js';
import { sanitizeScoreId, findScoreFile } from '../tools/_score-helpers.js';

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

async function createTestOrchestron(score: Score): Promise<Orchestron> {
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
    defaultHarness: 'fake',
  }).then((orchestron) => {
    orchestron.registry.register(score);
    return orchestron;
  });
}

describe('plugin-common tool functions', () => {
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
    const orchestron: Orchestron = { store, registry, hall, scoresDirs: [] };

    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });
    await new Promise((r) => setTimeout(r, 50));

    const result = await pauseConcert(orchestron, { concertId });
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
    const orchestron: Orchestron = { store, registry, hall, scoresDirs: [] };

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

  it('streams startConcert progress via onUpdate callback', async () => {
    const score: Score = {
      ...linearScore(),
      startMovement: 'slow',
      movements: [
        {
          id: 'slow',
          name: 'Slow',
          section: 'default',
          description: 'Slow step',
          harness: 'fake',
          prompt: 'S',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
    };
    const orchestron = await createTestOrchestron(score);
    orchestron.hall = new ConcertHall({
      store: orchestron.store,
      scoreRegistry: orchestron.registry,
      adapters: new Map([
        [
          'fake',
          new FakeHarnessAdapter({
            defaultResponse: {
              output: 'o',
              summary: 's',
              usage: { spend: 10, tokens: 100 },
              delayMs: 300,
              progressUpdates: [
                { atMs: 50, update: { type: 'tool_execution_start', toolName: 'git_status' } },
                { atMs: 150, update: { type: 'tool_execution_end', toolName: 'git_status', isError: false } },
              ],
            },
          }),
        ],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const onUpdate = vi.fn();
    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' }, onUpdate);
    expect(concertId).toBeDefined();
    expect(onUpdate).toHaveBeenCalledWith(
      expect.stringContaining('Started concert'),
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.stringContaining('git_status'),
    );
  });

  it('sanitizes score IDs correctly', () => {
    expect(sanitizeScoreId('Hello World!')).toBe('hello-world');
    expect(sanitizeScoreId('My Great Score v2')).toBe('my-great-score-v2');
    expect(sanitizeScoreId('already-valid')).toBe('already-valid');
  });

  it('converts usage to human-readable view', () => {
    const result = toUsageView({ spend: 1000000, tokens: 500 });
    expect(result.spend).toBe(1.0);
    expect(result.tokens).toBe(500);
  });

  it('creates a default evaluator from a HarnessAdapterResolver', async () => {
    const score = linearScore();
    const registry = new ScoreRegistry();
    registry.register(score);
    const store = new SqliteLoge(':memory:');
    const resolver: import('@orchestron/core').HarnessAdapterResolver = {
      resolve: async (name) => {
        if (name !== 'fake') {
          throw new Error(`Unknown harness: ${name}`);
        }
        return new FakeHarnessAdapter({
          defaultResponse: {
            output: 'output',
            summary: 'summary',
            usage: { spend: 10, tokens: 100 },
            structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
          },
        });
      },
    };
    const orchestron = await createOrchestron({
      storePath: ':memory:',
      scoresDirs: [],
      adapters: resolver,
      defaultHarness: 'fake',
    });
    orchestron.registry.register(score);

    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });
    const result = await waitForConcert(orchestron, { concertId });
    expect(result.concertId).toBe(concertId);
    expect(result.status).toBe('completed');
    expect(result.movements).toHaveLength(2);
  });

  it('returns current movement progress in status', async () => {
    const score: Score = {
      ...linearScore(),
      startMovement: 'slow',
      movements: [
        {
          id: 'slow',
          name: 'Slow',
          section: 'default',
          description: 'Slow step',
          harness: 'fake',
          prompt: 'S',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
    };
    const orchestron = await createTestOrchestron(score);
    orchestron.hall = new ConcertHall({
      store: orchestron.store,
      scoreRegistry: orchestron.registry,
      adapters: new Map([
        [
          'fake',
          new FakeHarnessAdapter({
            defaultResponse: {
              output: 'o',
              summary: 's',
              usage: { spend: 10, tokens: 100 },
              delayMs: 500,
              progressUpdates: [
                { atMs: 50, update: { type: 'tool_execution_start', toolName: 'git_status' } },
              ],
            },
          }),
        ],
      ]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const { concertId } = await startConcert(orchestron, { scoreId: 'linear-test' });

    await new Promise((r) => setTimeout(r, 100));

    const status = await getConcertStatus(orchestron, { concertId });
    expect(status.currentMovement).toBe('slow');
    expect(status.currentMovementProgress).toBeDefined();
    expect(status.currentMovementProgress?.type).toBe('tool_execution_start');
    expect(status.currentMovementProgress?.toolName).toBe('git_status');
  });
});

describe('plugin-common score tools', () => {
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

  it('rejects a score with mismatched id', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    const yaml = `id: other-id
name: "Mismatched"
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
      scoreId: 'requested-id',
      yaml,
      persist: false,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('does not match');
  });

  it('gets a score by id', async () => {
    const orchestron = await createTestOrchestron(linearScore());

    const result = await getScore(orchestron, { scoreId: 'linear-test' });
    expect(result.scoreId).toBe('linear-test');
    expect(result.persisted).toBe(false);
  });

  it('throws getScore for unknown score', async () => {
    const orchestron = await createTestOrchestron(linearScore());
    await expect(getScore(orchestron, { scoreId: 'nope' })).rejects.toThrow();
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
});
