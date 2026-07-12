import { describe, it, expect } from 'vitest';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Score } from '../types/score.js';

// ─── Use Case 1: Linear Plan → Review → End ─────────────────

function linearScore(): Score {
  return {
    id: 'plan-review',
    name: 'Plan & Review',
    description: 'Create a plan, review it, finalize',
    version: '1.0.0',
    startMovement: 'plan',
    movements: [
      {
        id: 'plan',
        name: 'Create Plan',
        section: 'planning',
        harness: 'fake',
        prompt: 'Create a plan for {{context.task}}',
        output: { mode: 'structured', schema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } } } },
        goal: { description: 'Plan created', strategy: 'llm_judge' },
        transitions: [{ to: 'review', on: 'success' }, { to: '__fail__', on: 'failure' }],
      },
      {
        id: 'review',
        name: 'Review Plan',
        section: 'review',
        harness: 'fake',
        prompt: 'Review: {{context.previousOutputs.plan}}',
        goal: { description: 'Plan approved', strategy: 'llm_judge' },
        transitions: [{ to: '__end__', on: 'success' }, { to: 'plan', on: 'failure' }],
      },
    ],
    program: { maxMovements: 10 },
  };
}

describe('Use Case: Plan → Review → End', () => {
  it('completes plan-review workflow with both steps passing', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(linearScore());

    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'Default plan output',
        summary: 'Completed step',
        usage: { spend: 10, tokens: 100 },
      },
      perMovement: {
        plan: {
          output: 'Step 1: Analysis\nStep 2: Implementation\nStep 3: Testing',
          structured: { steps: ['Analysis', 'Implementation', 'Testing'] },
          summary: 'Plan created successfully',
          usage: { spend: 15, tokens: 200 },
        },
      },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('plan-review', {
      initialContext: { task: 'Build a login feature' },
    });
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const state = await conductor.getState();
    expect(state.history).toHaveLength(2);
    expect(state.history[0].movementId).toBe('plan');
    expect(state.history[0].status).toBe('completed');
    expect(state.history[0].output).toContain('Analysis');
    expect(state.history[0].structured?.steps).toHaveLength(3);
    expect(state.history[1].movementId).toBe('review');
    expect(state.history[1].status).toBe('completed');
    expect(state.context.shared.task).toBe('Build a login feature');
    expect(state.usage.spend).toBe(25);
  });

  it('loops back from review to plan when goal not met', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(linearScore());

    const adapter = new FakeHarnessAdapter({
      defaultResponse: {
        output: 'Output',
        summary: 'Done',
        usage: { spend: 10, tokens: 100 },
      },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({
        perMovement: {
          plan: { achieved: true, confidence: 1, summary: 'Plan good', evidence: '' },
          review: { achieved: false, confidence: 0, summary: 'Needs revision', evidence: '' },
        },
      }),
    });

    const conductor = await hall.createConcert('plan-review', {
      initialContext: { task: 'Build a login feature' },
    });
    await conductor.start();

    // Review always fails → should loop and eventually hit maxMovements
    expect(conductor.status).toBe('failed');
    const state = await conductor.getState();
    expect(state.history.length).toBeGreaterThanOrEqual(4);
    // Should have at least two plan entries (looped back)
    const planEntries = state.history.filter(h => h.movementId === 'plan');
    const reviewEntries = state.history.filter(h => h.movementId === 'review');
    expect(planEntries.length).toBeGreaterThanOrEqual(2);
    expect(reviewEntries.length).toBeGreaterThanOrEqual(2);
  });

  it('produces correct events for the full lifecycle', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(linearScore());

    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 5, tokens: 50 } },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('plan-review');
    await conductor.start();

    const events = await store.getEvents(conductor.concertId);
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toEqual([
      'concert:started',
      'movement:started',
      'movement:completed',
      'movement:started',
      'movement:completed',
      'concert:completed',
    ]);
  });
});

// ─── Use Case 2: Constrained Workflow ────────────────────────

describe('Use Case: Constrained Workflow', () => {
  it('fails when token limit is exceeded', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'token-limited',
      name: 'Token Limited',
      description: 'Hits token limit',
      version: '1.0.0',
      startMovement: 'step_a',
      movements: [
        {
          id: 'step_a', name: 'A', section: 'x', description: 'x',
          harness: 'fake', prompt: 'A',
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: 'step_b', on: 'success' as const }],
        },
        {
          id: 'step_b', name: 'B', section: 'x', description: 'x',
          harness: 'fake', prompt: 'B',
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: 'step_c', on: 'success' as const }],
        },
        {
          id: 'step_c', name: 'C', section: 'x', description: 'x',
          harness: 'fake', prompt: 'C',
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: '__end__', on: 'success' as const }],
        },
      ],
      program: { maxTokens: 250 },
    });

    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 1, tokens: 100 } },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('token-limited');
    await conductor.start();

    // A: 100 tokens (total 100), B: 100 tokens (total 200), C: 100 tokens (total 300 > 250) → breach
    expect(conductor.status).toBe('failed');
    const events = await store.getEvents(conductor.concertId);
    expect(events.some(e => e.type === 'constraint:breached')).toBe(true);
  });
});

// ─── Use Case 3: Structured Output Flow ──────────────────────

describe('Use Case: Structured Output Flow', () => {
  it('passes structured output between movements', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'structured-flow',
      name: 'Structured Flow',
      description: 'Passes structured data between steps',
      version: '1.0.0',
      startMovement: 'research',
      movements: [
        {
          id: 'research',
          name: 'Research',
          section: 'planning',
          harness: 'fake',
          prompt: 'Research: {{context.topic}}',
          output: {
            mode: 'structured',
            schema: {
              type: 'object',
              properties: {
                findings: { type: 'array', items: { type: 'string' } },
                conclusion: { type: 'string' },
              },
            },
          },
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: 'summarize', on: 'success' }],
        },
        {
          id: 'summarize',
          name: 'Summarize',
          section: 'delivery',
          harness: 'fake',
          prompt: 'Summarize: {{context.previousOutputs.research}}',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    });

    const adapter = new FakeHarnessAdapter({
      perMovement: {
        research: {
          output: 'Key findings: AI safety, alignment, scaling laws',
          structured: {
            findings: ['AI safety is critical', 'Alignment research is active', 'Scaling laws continue to hold'],
            conclusion: 'The field is progressing rapidly',
          },
          summary: 'Research completed',
          usage: { spend: 20, tokens: 300 },
        },
        summarize: {
          output: 'Summary of research findings...',
          summary: 'Summary created',
          usage: { spend: 10, tokens: 150 },
        },
      },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await hall.createConcert('structured-flow', {
      initialContext: { topic: 'AI Safety' },
    });
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const state = await conductor.getState();
    expect(state.history).toHaveLength(2);
    expect(state.history[0].structured).toBeDefined();
    expect(state.history[0].structured!.findings).toContain('AI safety is critical');
    expect(state.history[0].structured!.conclusion).toBe('The field is progressing rapidly');
    expect(state.history[1].output).toBe('Summary of research findings...');
  });
});

// ─── Use Case 4: Dashboard-style Query ───────────────────────

describe('Use Case: Dashboard Queries', () => {
  it('can query aggregates across multiple concerts', async () => {
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'simple',
      name: 'Simple',
      description: 'One-step workflow',
      version: '1.0.0',
      startMovement: 'single',
      movements: [{
        id: 'single', name: 'Single', section: 'x', description: 'x',
        harness: 'fake', prompt: 'Do it',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: '__end__', on: 'success' as const }],
      }],
      program: {},
    });

    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 10, tokens: 100 } },
    });

    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['fake', adapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    // Run 3 successful concerts
    for (let i = 0; i < 3; i++) {
      const c = await hall.createConcert('simple', {
        initialContext: { number: i },
      });
      await c.start();
      expect(c.status).toBe('completed');
    }

    // Query aggregates (simulating what the dashboard would do)
    const aggregates = await store.getAggregates();
    expect(aggregates.totalConcerts).toBe(3);
    expect(aggregates.activeConcerts).toBe(0);
    expect(aggregates.totalSpend).toBe(30);
    expect(aggregates.totalTokens).toBe(300);
    expect(aggregates.failureRate).toBe(0);

    // List concerts
    const allConcerts = await store.listConcerts();
    expect(allConcerts).toHaveLength(3);

    // Get individual concert details
    const firstConcert = allConcerts[0];
    const movementHistory = await store.getMovementHistory(firstConcert.id);
    expect(movementHistory).toHaveLength(1);
    expect(movementHistory[0].movementId).toBe('single');
  });
});
