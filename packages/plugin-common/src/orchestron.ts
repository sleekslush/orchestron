import { dirname, join } from 'node:path';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type {
  ConcertHall,
  Evaluator,
  HarnessAdapter,
  HarnessAdapterResolver,
  LiveEventLog,
  ScoreRegistry,
  SqliteLoge,
} from '@orchestron/core';
import {
  resolveOrchestronConfig,
  DEFAULT_CONFIG_DIR,
  DEFAULT_STORE_PATH,
  DEFAULT_SCORES_DIR,
  LOCAL_SCORES_DIR,
  ensureDir,
  loadScoresFromDir,
} from '@orchestron/core';

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
  liveEventLog?: LiveEventLog;
  tracesDir?: string;
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

  const { SqliteLoge, ScoreRegistry, ConcertHall, HarnessEvaluator, LiveEventLog } = await import(
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

  const tracesDir = storePath === ':memory:'
    ? mkdtempSync(join(realpathSync(tmpdir()), 'orchestron-trace-'))
    : join(dirname(storePath), 'traces');
  ensureDir(tracesDir);
  const liveEventLog = new LiveEventLog(tracesDir);

  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: adapterResolver,
    evaluator,
    tracesDir,
    liveEventLog,
    defaultHarness,
  });

  return { store, registry, hall, liveEventLog, tracesDir, scoresDirs };
}
