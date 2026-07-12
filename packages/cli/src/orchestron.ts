import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { SqliteLoge, ScoreRegistry, ConcertHall, FakeEvaluator } from '@orchestron/core';
import { PiAdapter } from '@orchestron/adapter-pi';
import { OpencodeAdapter } from '@orchestron/adapter-opencode';
import type { HarnessAdapter } from '@orchestron/core';

export const DEFAULT_CONFIG_DIR = join(homedir(), '.orchestron');
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, 'store.db');
export const DEFAULT_SCORES_DIR = join(DEFAULT_CONFIG_DIR, 'scores');

export interface OrchestronOptions {
  storePath?: string;
  scoresDirs?: string[];
  adapters?: Map<string, HarnessAdapter>;
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

  const store = new SqliteLoge(storePath);
  const registry = new ScoreRegistry();

  for (const dir of scoresDirs) {
    loadScoresFromDir(dir, registry);
  }

  const adapters = options.adapters ?? defaultAdapters();
  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters,
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
  });

  return { store, registry, hall };
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

function defaultAdapters(): Map<string, HarnessAdapter> {
  return new Map<string, HarnessAdapter>([
    ['pi', new PiAdapter()],
    ['opencode', new OpencodeAdapter()],
  ]);
}
