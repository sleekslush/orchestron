import { nanoid } from 'nanoid';
import yaml from 'js-yaml';
import type { Concert, ConcertID, ConcertFilter } from '../types/concert.js';
import type { Score, ScoreID } from '../types/score.js';
import type { HarnessAdapter, HarnessAdapterResolver } from '../types/adapter.js';
import type { ConcertStore } from '../store/concert-store.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { Conductor } from '../conductor/conductor.js';
import type { IConductor } from '../conductor/conductor-interface.js';
import type { ChildConcertFactory } from '../conductor/child-concert-factory.js';
import type { StartOptions } from '../conductor/start-options.js';
import { HarnessEvaluator, type Evaluator } from '../evaluator/index.js';
import { ConductorPanic } from '../types/errors.js';

export interface ConcertHallOptions {
  store: ConcertStore;
  scoreRegistry: ScoreRegistry;
  adapters: Map<string, HarnessAdapter> | HarnessAdapterResolver;
  evaluator?: Evaluator;
  tracesDir?: string;
  defaultHarness?: string;
}

interface AdapterResolver {
  get(name: string): Promise<HarnessAdapter>;
}

export class ConcertHall implements ChildConcertFactory {
  private conductors = new Map<ConcertID, Conductor>();
  private parentToChildren = new Map<ConcertID, ConcertID[]>();
  private store: ConcertStore;
  private scoreRegistry: ScoreRegistry;
  private adapterResolver: AdapterResolver;
  private evaluator: Evaluator;
  private tracesDir?: string;
  private defaultHarness?: string;

  constructor(options: ConcertHallOptions) {
    this.store = options.store;
    this.scoreRegistry = options.scoreRegistry;
    this.adapterResolver = this.createAdapterResolver(options.adapters);
    if (!options.evaluator) {
      throw new Error('ConcertHall requires an evaluator; pass one explicitly or use FakeEvaluator only in tests.');
    }
    this.evaluator = options.evaluator;
    this.tracesDir = options.tracesDir;
    this.defaultHarness = options.defaultHarness;
  }

  private createAdapterResolver(
    adapters: Map<string, HarnessAdapter> | HarnessAdapterResolver,
  ): AdapterResolver {
    if (adapters instanceof Map) {
      return {
        get: async (name) => {
          const adapter = adapters.get(name);
          if (!adapter) {
            throw new ConductorPanic(
              `No adapter registered for harness type '${name}'`,
              'INTERNAL_ERROR',
            );
          }
          return adapter;
        },
      };
    }

    return {
      get: adapters.resolve.bind(adapters),
    };
  }

  private async resolveEvaluator(score: Score, explicitHarness?: string): Promise<Evaluator> {
    const harness = score.evaluator?.harness ?? explicitHarness;
    if (harness) {
      const adapter = await this.adapterResolver.get(harness);
      if (!adapter) {
        throw new ConductorPanic(
          `No adapter registered for evaluator harness '${harness}' in score '${score.id}'`,
          'INTERNAL_ERROR',
        );
      }
      return new HarnessEvaluator({
        adapter,
        promptTemplate: score.evaluator?.prompt,
        model: score.evaluator?.model,
        provider: score.evaluator?.provider,
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
      explicitHarness: options?.harness,
    };

    const scoreYaml = yaml.dump(score);
    await this.store.saveConcert(concert, scoreYaml);

    const conductor = new Conductor(
      concert,
      score,
      this.store,
      this,
      this.adapterResolver,
      await this.resolveEvaluator(score, options?.harness),
      this.tracesDir,
      this.defaultHarness,
    );

    this.conductors.set(concert.id, conductor);

    if (concert.parentConcertId) {
      const siblings = this.parentToChildren.get(concert.parentConcertId) ?? [];
      siblings.push(concert.id);
      this.parentToChildren.set(concert.parentConcertId, siblings);
    }

    return conductor;
  }

  async loadConcert(id: ConcertID): Promise<Conductor | undefined> {
    if (this.conductors.has(id)) {
      return this.conductors.get(id);
    }

    const stored = await this.store.getConcert(id);
    if (!stored) return undefined;

    try {
      let score: Score;
      const scoreYaml = await this.store.getConcertScoreYaml(id);
      if (scoreYaml) {
        score = yaml.load(scoreYaml) as Score;
      } else {
        score = this.scoreRegistry.get(stored.scoreId);
      }
      const conductor = new Conductor(
        stored,
        score,
        this.store,
        this,
        this.adapterResolver,
        await this.resolveEvaluator(score, stored.explicitHarness),
        this.tracesDir,
        this.defaultHarness,
      );
      this.conductors.set(id, conductor);

      if (stored.parentConcertId) {
        const siblings = this.parentToChildren.get(stored.parentConcertId) ?? [];
        if (!siblings.includes(id)) {
          siblings.push(id);
          this.parentToChildren.set(stored.parentConcertId, siblings);
        }
      }

      return conductor;
    } catch (err) {
      console.error(`Failed to load concert '${id}':`, err);
      return undefined;
    }
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
        let score: Score;
        const scoreYaml = await this.store.getConcertScoreYaml(concert.id);
        if (scoreYaml) {
          score = yaml.load(scoreYaml) as Score;
        } else {
          score = this.scoreRegistry.get(concert.scoreId);
        }
        const conductor = new Conductor(
          concert,
          score,
          this.store,
          this,
          this.adapterResolver,
          await this.resolveEvaluator(score, concert.explicitHarness),
          this.tracesDir,
          this.defaultHarness,
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
