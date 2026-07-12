import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeHarnessAdapter, ScoreRegistry, SqliteLoge, ConcertHall } from '@orchestron/core';
import type { Score } from '@orchestron/core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import orchestronPlugin from '../index.js';
import { createOrchestron, type Orchestron } from '../orchestron.js';
import { startConcert } from '../tools/start-concert.js';
import { getConcertStatus } from '../tools/get-status.js';
import { listConcerts } from '../tools/list-concerts.js';
import { pauseConcert } from '../tools/pause-concert.js';
import { cancelConcert } from '../tools/cancel-concert.js';
import { listScores } from '../tools/list-scores.js';

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
  }).then((orchestron) => {
    orchestron.registry.register(score);
    return orchestron;
  });
}

describe('Orchestron Pi plugin tools', () => {
  it('starts a concert and returns its initial status', async () => {
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

    // Wait for the background start to complete.
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
    expect(status.usage.spend).toBe(20);
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
    const orchestron = await createTestOrchestron({
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
    });

    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'o',
        summary: 's',
        usage: { spend: 10, tokens: 100 },
        delayMs: 500,
      },
    });
    const registry = new ScoreRegistry();
    registry.register(orchestron.registry.get('linear-test'));
    const store = new SqliteLoge(':memory:');
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
    });
    const orchestron2: Orchestron = { store, registry, hall, scoresDirs: [] };

    const { concertId } = await startConcert(orchestron2, { scoreId: 'linear-test' });
    await new Promise((r) => setTimeout(r, 50));

    const result = await pauseConcert(orchestron2, { concertId });
    expect(result.status).toBe('paused');

    const stored = await store.getConcert(concertId);
    expect(stored!.status).toBe('paused');
  });

  it('cancels a running concert', async () => {
    const orchestron = await createTestOrchestron({
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
    });

    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'o',
        summary: 's',
        usage: { spend: 10, tokens: 100 },
        delayMs: 500,
      },
    });
    const registry = new ScoreRegistry();
    registry.register(orchestron.registry.get('linear-test'));
    const store = new SqliteLoge(':memory:');
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
    });
    const orchestron2: Orchestron = { store, registry, hall, scoresDirs: [] };

    const { concertId } = await startConcert(orchestron2, { scoreId: 'linear-test' });

    // Wait until the concert transitions to running.
    await new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        const state = await store.getConcert(concertId);
        if (state?.status === 'running') {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    await cancelConcert(orchestron2, { concertId });

    // Cancel finalizes asynchronously; poll until the concert is done.
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
});

describe('Orchestron Pi plugin extension', () => {
  it('registers all orchestron tools', () => {
    const registered: string[] = [];
    const pi = {
      registerTool: vi.fn((tool) => {
        registered.push(tool.name);
      }),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    orchestronPlugin(pi);

    expect(registered).toEqual([
      'orchestron_start_concert',
      'orchestron_get_concert_status',
      'orchestron_list_concerts',
      'orchestron_pause_concert',
      'orchestron_cancel_concert',
      'orchestron_list_scores',
      'orchestron_create_score',
      'orchestron_edit_score',
      'orchestron_get_score',
      'orchestron_validate_score',
    ]);
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });
});
