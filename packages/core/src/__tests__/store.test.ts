import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteLoge } from '../store/sqlite-loge.js';
import type { Concert } from '../types/concert.js';

describe('SqliteLoge', () => {
  let store: SqliteLoge;

  beforeEach(() => {
    store = new SqliteLoge(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const makeConcert = (overrides: Partial<Concert> = {}): Concert => ({
    id: 'test-concert-1',
    scoreId: 'test-score',
    status: 'pending',
    startedAt: new Date(),
    completedAt: undefined,
    currentMovement: null,
    history: [],
    context: { shared: { ticket: 'PROJ-123' } },
    usage: {},
    triggeredBy: 'cli',
    childConcertIds: [],
    ...overrides,
  });

  it('should save and retrieve a concert', async () => {
    const concert = makeConcert();
    await store.saveConcert(concert);

    const retrieved = await store.getConcert('test-concert-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('test-concert-1');
    expect(retrieved!.scoreId).toBe('test-score');
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.context.shared.ticket).toBe('PROJ-123');
  });

  it('should update a concert', async () => {
    await store.saveConcert(makeConcert());
    await store.updateConcert({ id: 'test-concert-1', status: 'running', usage: { spend: 100 } });

    const retrieved = await store.getConcert('test-concert-1');
    expect(retrieved!.status).toBe('running');
    expect(retrieved!.usage.spend).toBe(100);
  });

  it('should list concerts with filters', async () => {
    await store.saveConcert(makeConcert({ id: 'c1', status: 'running' }));
    await store.saveConcert(makeConcert({ id: 'c2', status: 'completed' }));
    await store.saveConcert(makeConcert({ id: 'c3', status: 'failed' }));

    const all = await store.listConcerts();
    expect(all).toHaveLength(3);

    const running = await store.listConcerts({ status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('c1');

    const limited = await store.listConcerts({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('should append and retrieve movement history', async () => {
    await store.saveConcert(makeConcert());

    const movement = {
      movementId: 'plan',
      movementName: 'Plan',
      status: 'completed' as const,
      output: 'Planned the work',
      summary: 'Planning complete',
      goalEvaluation: { achieved: true, confidence: 1, summary: 'Goal met', evidence: '' },
      usage: { spend: 50 },
      durationMs: 1000,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    await store.appendMovement('test-concert-1', movement);
    const history = await store.getMovementHistory('test-concert-1');
    expect(history).toHaveLength(1);
    expect(history[0].movementId).toBe('plan');
    expect(history[0].usage.spend).toBe(50);
  });

  it('should push and retrieve events', async () => {
    await store.saveConcert(makeConcert());

    await store.pushEvent({
      type: 'concert:started',
      concertId: 'test-concert-1',
      scoreId: 'test-score',
      timestamp: new Date(),
    });

    await store.pushEvent({
      type: 'movement:started',
      concertId: 'test-concert-1',
      movementId: 'plan',
      timestamp: new Date(),
    });

    const events = await store.getEvents('test-concert-1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('concert:started');
    expect(events[1].type).toBe('movement:started');
  });

  it('should compute aggregates', async () => {
    const now = Date.now();
    await store.saveConcert(
      makeConcert({ id: 'c1', status: 'running', startedAt: new Date(now - 5000) }),
    );
    await store.saveConcert(
      makeConcert({
        id: 'c2',
        status: 'completed',
        startedAt: new Date(now - 10000),
        completedAt: new Date(now - 2000),
        usage: { spend: 100, tokens: 500 },
      }),
    );
    await store.saveConcert(
      makeConcert({
        id: 'c3',
        status: 'failed',
        startedAt: new Date(now - 15000),
        completedAt: new Date(now - 5000),
        usage: { spend: 50, tokens: 200 },
      }),
    );

    const agg = await store.getAggregates();
    expect(agg.totalConcerts).toBe(3);
    expect(agg.activeConcerts).toBe(1);
    expect(agg.totalSpend).toBe(150);
    expect(agg.totalTokens).toBe(700);
    expect(agg.failureRate).toBeCloseTo(1 / 3, 2);
  });

  it('should delete a concert and its related data', async () => {
    await store.saveConcert(makeConcert());
    await store.pushEvent({ type: 'concert:started', concertId: 'test-concert-1', scoreId: 'test-score', timestamp: new Date() });

    await store.deleteConcert('test-concert-1');
    const retrieved = await store.getConcert('test-concert-1');
    expect(retrieved).toBeNull();

    const events = await store.getEvents('test-concert-1');
    expect(events).toHaveLength(0);
  });
});
