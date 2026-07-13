import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ConcertHall,
  Evaluator,
  HarnessAdapter,
  HarnessAdapterResolver,
  ScoreRegistry,
  SqliteLoge,
} from '@orchestron/core';
import { resolveOrchestronConfig } from '@orchestron/core';

export const DEFAULT_CONFIG_DIR = join(homedir(), '.orchestron');
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, 'store.db');
export const DEFAULT_SCORES_DIR = join(DEFAULT_CONFIG_DIR, 'scores');
export const LOCAL_SCORES_DIR = join(process.cwd(), '.orchestron', 'scores');

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

  const evaluator = options.evaluator ?? (() => {
    if (adapterResolver instanceof Map && adapterResolver.size > 0) {
      const target = defaultHarness;
      if (target) {
        const adapter = adapterResolver.get(target);
        if (adapter) {
          return new HarnessEvaluator({ adapter });
        }
        throw new Error(
          `Default harness '${target}' not found in adapters. Available: ${Array.from(adapterResolver.keys()).join(', ')}`,
        );
      }
      const first = adapterResolver.values().next().value;
      if (!first) {
        throw new Error('No adapters available to create a default HarnessEvaluator');
      }
      return new HarnessEvaluator({ adapter: first });
    }
    throw new Error(
      'createOrchestron requires an evaluator. Pass one via options.evaluator or provide adapters so a default HarnessEvaluator can be created.',
    );
  })();

  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: adapterResolver,
    evaluator,
    defaultHarness,
  });

  return { store, registry, hall, scoresDirs };
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function loadScoresFromDir(dir: string, registry: ScoreRegistry): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;

    if (/\.score\.(ya?ml|json)$/i.test(entry)) {
      registry.loadFrom(fullPath);
    }
  }
}
