import { nanoid } from 'nanoid';
import type { Concert, ConcertID, ConcertFilter } from '../types/concert.js';
import type { Score, ScoreID } from '../types/score.js';
import type { HarnessAdapter } from '../types/adapter.js';
import type { ConcertStore } from '../store/concert-store.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { Conductor } from '../conductor/conductor.js';
import type { IConductor } from '../conductor/conductor-interface.js';
import type { ChildConcertFactory } from '../conductor/child-concert-factory.js';
import type { StartOptions } from '../conductor/start-options.js';
import { FakeEvaluator, HarnessEvaluator, type Evaluator } from '../evaluator/index.js';
import { ConductorPanic } from '../types/errors.js';

export interface ConcertHallOptions {
  store: ConcertStore;
  scoreRegistry: ScoreRegistry;
  adapters: Map<string, HarnessAdapter>;
  evaluator?: Evaluator;
}

export class ConcertHall implements ChildConcertFactory {
  private conductors = new Map<ConcertID, Conductor>();
  private parentToChildren = new Map<ConcertID, ConcertID[]>();
  private store: ConcertStore;
  private scoreRegistry: ScoreRegistry;
  private adapters: ReadonlyMap<string, HarnessAdapter>;
  private evaluator: Evaluator;

  constructor(options: ConcertHallOptions) {
    this.store = options.store;
    this.scoreRegistry = options.scoreRegistry;
    this.adapters = options.adapters;
    this.evaluator = options.evaluator ?? new FakeEvaluator({ alwaysSucceed: true });
  }

  private resolveEvaluator(score: Score): Evaluator {
    if (score.evaluator?.harness) {
      const adapter = this.adapters.get(score.evaluator.harness);
      if (!adapter) {
        throw new ConductorPanic(
          `No adapter registered for evaluator harness '${score.evaluator.harness}' in score '${score.id}'`,
          'INTERNAL_ERROR',
        );
      }
      return new HarnessEvaluator({
        adapter,
        promptTemplate: score.evaluator.prompt,
      });
    }
    return this.evaluator;
  }

  async createConcert(
    scoreId: ScoreID,
    options?: StartOptions,
  ): Promise<Conductor> {
    return this.doCreateConcert(scoreId, options);
  }

  async createChildConcert(
    scoreId: ScoreID,
    options?: StartOptions,
  ): Promise<IConductor> {
    return this.doCreateConcert(scoreId, options);
  }

  private async doCreateConcert(
    scoreId: ScoreID,
    options?: StartOptions,
  ): Promise<Conductor> {
    const score = this.scoreRegistry.get(scoreId);

    const concert: Concert = {
      id: nanoid(12),
      scoreId: score.id,
      status: 'pending',
      startedAt: new Date(),
      currentMovement: null,
      history: [],
      context: { shared: { ...options?.initialContext } },
      usage: {},
      triggeredBy: options?.triggeredBy ?? 'cli',
      parentConcertId: options?.parentConcertId,
      childConcertIds: [],
    };

    await this.store.saveConcert(concert);

    const conductor = new Conductor(
      concert,
      score,
      this.store,
      this,
      this.adapters,
      this.resolveEvaluator(score),
    );

    this.conductors.set(concert.id, conductor);

    if (concert.parentConcertId) {
      const siblings = this.parentToChildren.get(concert.parentConcertId) ?? [];
      siblings.push(concert.id);
      this.parentToChildren.set(concert.parentConcertId, siblings);
    }

    return conductor;
  }

  getConcert(id: ConcertID): Conductor | undefined {
    return this.conductors.get(id);
  }

  list(filter?: ConcertFilter): Conductor[] {
    let results = Array.from(this.conductors.values());
    if (filter?.status) {
      results = results.filter((c) => c.status === filter.status);
    }
    if (filter?.scoreId) {
      results = results.filter((c) => c.scoreId === filter.scoreId);
    }
    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }
    return results;
  }

  async waitForConcert(id: ConcertID): Promise<Concert> {
    const conductor = this.conductors.get(id);
    if (!conductor) {
      throw new Error(`Concert '${id}' not found in hall`);
    }

    while (conductor.status === 'running' || conductor.status === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return conductor.getState();
  }

  getChildConcerts(parentId: ConcertID): ConcertID[] {
    return [...(this.parentToChildren.get(parentId) ?? [])];
  }

  async rehydrate(): Promise<void> {
    const runningConcerts = await this.store.listConcerts({
      status: 'running',
    });
    const pausedConcerts = await this.store.listConcerts({
      status: 'paused',
    });

    const all = [...runningConcerts, ...pausedConcerts];

    for (const concert of all) {
      try {
        const score = this.scoreRegistry.get(concert.scoreId);
        const conductor = new Conductor(
          concert,
          score,
          this.store,
          this,
          this.adapters,
          this.resolveEvaluator(score),
        );
        this.conductors.set(concert.id, conductor);

        if (concert.parentConcertId) {
          const siblings = this.parentToChildren.get(concert.parentConcertId) ?? [];
          siblings.push(concert.id);
          this.parentToChildren.set(concert.parentConcertId, siblings);
        }
      } catch {
        await this.store.updateConcert({
          id: concert.id,
          status: 'failed',
          completedAt: new Date(),
        });
      }
    }

    for (const concert of runningConcerts) {
      const conductor = this.conductors.get(concert.id);
      if (conductor) {
        conductor.recover().catch((err) => {
          this.store.updateConcert({
            id: concert.id,
            status: 'failed',
            completedAt: new Date(),
          }).catch(() => {});
        });
      }
    }
  }
}
