import { join } from 'node:path';
import type {
  ConcertHall,
  Evaluator,
  HarnessAdapter,
  HarnessAdapterResolver,
  ScoreRegistry,
  SqliteLoge,
} from '@orchestron/core';
import { resolveOrchestronConfig, DEFAULT_CONFIG_DIR, DEFAULT_STORE_PATH, DEFAULT_SCORES_DIR, LOCAL_SCORES_DIR, ensureDir, loadScoresFromDir } from '@orchestron/core';

export { DEFAULT_CONFIG_DIR, DEFAULT_STORE_PATH, DEFAULT_SCORES_DIR, LOCAL_SCORES_DIR };

export interface OrchestronOptions {
  storePath?: string;
  scoresDirs?: string[];
  adapters?: Map<string, HarnessAdapter> | HarnessAdapterResolver;
  evaluator?: Evaluator;
  defaultHarness?: string;
}

export interface Orchestron {
  store: SqliteLoge;
  registry: ScoreRegistry;
  hall: ConcertHall;
  scoresDirs: string[];
}

export async function createOrchestron(options: OrchestronOptions = {}): Promise<Orchestron> {
  const { storePath, scoresDirs, defaultHarness } = resolveOrchestronConfig(options, {
    storePath: DEFAULT_STORE_PATH,
    scoresDirs: [LOCAL_SCORES_DIR, DEFAULT_SCORES_DIR],
  });

  ensureDir(DEFAULT_CONFIG_DIR);
  for (const dir of scoresDirs) {
    ensureDir(dir);
  }

  const { SqliteLoge, ScoreRegistry, ConcertHall, HarnessEvaluator } = await import(
    '@orchestron/core'
  );

  const store = new SqliteLoge(storePath);
  const registry = new ScoreRegistry();

  for (const dir of scoresDirs) {
    loadScoresFromDir(dir, registry);
  }

  const adapterResolver = options.adapters ?? new Map<string, HarnessAdapter>();

  const evaluator = options.evaluator ?? (await (async () => {
    if (adapterResolver instanceof Map) {
      const target = defaultHarness;
      const adapter = adapterResolver.get(target);
      if (adapter) {
        return new HarnessEvaluator({ adapter });
      }
      const first = adapterResolver.values().next().value;
      if (first) {
        return new HarnessEvaluator({ adapter: first });
      }
      throw new Error(
        `Default harness '${target}' not found in adapters and no fallback is available.`,
      );
    }

    const adapter = await adapterResolver.resolve(defaultHarness);
    return new HarnessEvaluator({ adapter });
  })());

  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: adapterResolver,
    evaluator,
    defaultHarness,
  });

  return { store, registry, hall, scoresDirs };
}


