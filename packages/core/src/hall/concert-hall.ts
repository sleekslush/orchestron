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
import { createAdapterResolver, type AdapterResolver } from '../adapter-resolver.js';

export interface ConcertHallOptions {
  store: ConcertStore;
  scoreRegistry: ScoreRegistry;
  adapters: Map<string, HarnessAdapter> | HarnessAdapterResolver;
  evaluator?: Evaluator;
  tracesDir?: string;
  defaultHarness?: string;
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
    this.adapterResolver = createAdapterResolver(options.adapters);
    if (!options.evaluator) {
      throw new Error('ConcertHall requires an evaluator; pass one explicitly or use FakeEvaluator only in tests.');
    }
    this.evaluator = options.evaluator;
    this.tracesDir = options.tracesDir;
    this.defaultHarness = options.defaultHarness;
  }

  private async buildConductor(
    concert: Concert,
    score: Score,
    explicitHarness?: string,
  ): Promise<Conductor> {
    const conductor = new Conductor(
      concert,
      score,
      this.store,
      this,
      this.adapterResolver,
      await this.resolveEvaluator(score, explicitHarness),
      this.tracesDir,
      this.defaultHarness,
      (id) => this.cleanupConductor(id),
    );
    return conductor;
  }

  private cleanupConductor(id: ConcertID): void {
    this.conductors.delete(id);
    for (const [parentId, children] of this.parentToChildren.entries()) {
      const filtered = children.filter((childId) => childId !== id);
      if (filtered.length === 0) {
        this.parentToChildren.delete(parentId);
      } else {
        this.parentToChildren.set(parentId, filtered);
      }
    }
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

  /**
   * Load a concert's score (from stored YAML or registry), build a
   * Conductor, register it in {@link conductors}, and link parent-child
   * relationships.  Shared by {@link loadConcert} and {@link rehydrate}.
   */
  private async hydrateConductor(concert: Concert): Promise<Conductor> {
    let score: Score;
    const scoreYaml = await this.store.getConcertScoreYaml(concert.id);
    if (scoreYaml) {
      score = yaml.load(scoreYaml) as Score;
    } else {
      score = this.scoreRegistry.get(concert.scoreId);
    }
    const conductor = await this.buildConductor(concert, score, concert.explicitHarness);
    this.conductors.set(concert.id, conductor);

    if (concert.parentConcertId) {
      const siblings = this.parentToChildren.get(concert.parentConcertId) ?? [];
      if (!siblings.includes(concert.id)) {
        siblings.push(concert.id);
        this.parentToChildren.set(concert.parentConcertId, siblings);
      }
    }

    return conductor;
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

    const conductor = await this.buildConductor(concert, score, options?.harness);

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
      const conductor = await this.hydrateConductor(stored);
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

  async close(): Promise<void> {
    const ids = Array.from(this.conductors.keys());
    await Promise.all(
      ids.map((id) => this.conductors.get(id)!.cancel().catch(() => {})),
    );
    this.conductors.clear();
    this.parentToChildren.clear();
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
      if (this.conductors.has(concert.id)) {
        continue;
      }
      try {
        await this.hydrateConductor(concert);
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
