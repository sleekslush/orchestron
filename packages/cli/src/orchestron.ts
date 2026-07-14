import { dirname, join, resolve } from 'node:path';
import type { Evaluator, HarnessAdapter, HarnessAdapterResolver, SqliteLoge, ScoreRegistry, ConcertHall } from '@orchestron/core';
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
}

export async function withOrchestron<T>(
  options: OrchestronOptions,
  fn: (orchestron: Orchestron) => Promise<T>,
): Promise<T> {
  const orchestron = await createOrchestron(options);
  try {
    return await fn(orchestron);
  } finally {
    try {
      await orchestron.hall.close();
    } catch {
      // ignore
    }
    try {
      orchestron.store.close();
    } catch {
      // ignore
    }
  }
}

export async function createOrchestron(options: OrchestronOptions = {}): Promise<Orchestron> {
  const { storePath, scoresDirs, opencodeProvider, opencodeModelId, piProvider, piModelId, defaultHarness } = resolveOrchestronConfig(
    options,
    {
      storePath: DEFAULT_STORE_PATH,
      scoresDirs: [LOCAL_SCORES_DIR, DEFAULT_SCORES_DIR],
    },
  );

  ensureDir(DEFAULT_CONFIG_DIR);
  for (const dir of scoresDirs) {
    ensureDir(dir);
  }

  const { SqliteLoge, ScoreRegistry, ConcertHall, HarnessEvaluator } = await import('@orchestron/core');
  const { OpencodeAdapter } = await import('@orchestron/adapter-opencode');

  const store = new SqliteLoge(storePath);
  const registry = new ScoreRegistry();

  for (const dir of scoresDirs) {
    loadScoresFromDir(dir, registry);
  }

  const adapterResolver = options.adapters ?? new LazyAdapterResolver();
  const opencodeAdapter = new OpencodeAdapter({ embedded: { port: 0 }, provider: opencodeProvider, modelId: opencodeModelId });
  if (adapterResolver instanceof LazyAdapterResolver) {
    adapterResolver.register('opencode', opencodeAdapter);
    const { PiAdapter } = await import('@orchestron/adapter-pi');
    adapterResolver.register('pi', new PiAdapter({ provider: piProvider, modelId: piModelId }));
  }

  let evaluator = options.evaluator;
  if (!evaluator) {
    const effectiveDefaultHarness = defaultHarness;
    let defaultAdapter: HarnessAdapter;
    if (adapterResolver instanceof Map) {
      const adapter = adapterResolver.get(effectiveDefaultHarness);
      if (adapter) {
        defaultAdapter = adapter;
      } else {
        const first = adapterResolver.values().next().value;
        if (first) {
          defaultAdapter = first;
        } else {
          throw new Error(
            `Default harness '${effectiveDefaultHarness}' is not registered and no fallback is available.`,
          );
        }
      }
    } else {
      defaultAdapter = await adapterResolver.resolve(effectiveDefaultHarness);
    }
    evaluator = new HarnessEvaluator({ adapter: defaultAdapter });
  }

  const tracesDir = join(dirname(storePath), 'traces');

  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: adapterResolver,
    evaluator,
    tracesDir,
    defaultHarness,
  });

  return { store, registry, hall };
}

class LazyAdapterResolver implements HarnessAdapterResolver {
  private adapters = new Map<string, HarnessAdapter>();

  register(name: string, adapter: HarnessAdapter): void {
    this.adapters.set(name, adapter);
  }

  async resolve(name: string): Promise<HarnessAdapter> {
    const cached = this.adapters.get(name);
    if (cached) return cached;

    let Adapter: new () => HarnessAdapter;
    switch (name) {
      case 'pi':
        ({ PiAdapter: Adapter } = await import('@orchestron/adapter-pi'));
        break;
      case 'opencode':
        ({ OpencodeAdapter: Adapter } = await import('@orchestron/adapter-opencode'));
        break;
      default:
        throw new Error(`Unknown harness adapter: ${name}`);
    }

    const adapter = new Adapter();
    this.adapters.set(name, adapter);
    return adapter;
  }
}


