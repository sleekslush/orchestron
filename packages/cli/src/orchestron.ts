import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import type { HarnessAdapter, HarnessAdapterResolver, SqliteLoge, ScoreRegistry, ConcertHall } from '@orchestron/core';

export const DEFAULT_CONFIG_DIR = join(homedir(), '.orchestron');
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, 'store.db');
export const DEFAULT_SCORES_DIR = join(DEFAULT_CONFIG_DIR, 'scores');

export interface OrchestronOptions {
  storePath?: string;
  scoresDirs?: string[];
  adapters?: Map<string, HarnessAdapter> | HarnessAdapterResolver;
}

export interface Orchestron {
  store: SqliteLoge;
  registry: ScoreRegistry;
  hall: ConcertHall;
}

export async function createOrchestron(options: OrchestronOptions = {}): Promise<Orchestron> {
  const storePath = options.storePath ?? DEFAULT_STORE_PATH;
  const scoresDirs = options.scoresDirs ?? [DEFAULT_SCORES_DIR];

  ensureDir(DEFAULT_CONFIG_DIR);
  for (const dir of scoresDirs) {
    ensureDir(dir);
  }

  const { SqliteLoge, ScoreRegistry, ConcertHall, FakeEvaluator } = await import('@orchestron/core');

  const store = new SqliteLoge(storePath);
  const registry = new ScoreRegistry();

  for (const dir of scoresDirs) {
    loadScoresFromDir(dir, registry);
  }

  const adapters = options.adapters ?? new LazyAdapterResolver();
  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters,
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });

  return { store, registry, hall };
}

class LazyAdapterResolver implements HarnessAdapterResolver {
  private adapters = new Map<string, HarnessAdapter>();

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
