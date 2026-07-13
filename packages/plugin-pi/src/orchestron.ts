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

export const DEFAULT_CONFIG_DIR = join(homedir(), '.orchestron');
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, 'store.db');
export const DEFAULT_SCORES_DIR = join(DEFAULT_CONFIG_DIR, 'scores');
export const LOCAL_SCORES_DIR = join(process.cwd(), '.orchestron', 'scores');

export interface OrchestronOptions {
  storePath?: string;
  scoresDirs?: string[];
  adapters?: Map<string, HarnessAdapter> | HarnessAdapterResolver;
  evaluator?: Evaluator;
}

export interface Orchestron {
  store: SqliteLoge;
  registry: ScoreRegistry;
  hall: ConcertHall;
  scoresDirs: string[];
}

export async function createOrchestron(options: OrchestronOptions = {}): Promise<Orchestron> {
  const storePath = options.storePath ?? process.env.ORCHESTRON_STORE_PATH ?? DEFAULT_STORE_PATH;
  const scoresDirs =
    options.scoresDirs ??
    (process.env.ORCHESTRON_SCORES_DIRS
      ? process.env.ORCHESTRON_SCORES_DIRS.split(',').map((s) => s.trim())
      : [LOCAL_SCORES_DIR, DEFAULT_SCORES_DIR]);

  ensureDir(DEFAULT_CONFIG_DIR);
  for (const dir of scoresDirs) {
    ensureDir(dir);
  }

  const { SqliteLoge, ScoreRegistry, ConcertHall, HarnessEvaluator } = await import(
    '@orchestron/core'
  );
  const { PiAdapter } = await import('@orchestron/adapter-pi');
  const { OpencodeAdapter } = await import('@orchestron/adapter-opencode');

  const store = new SqliteLoge(storePath);
  const registry = new ScoreRegistry();

  for (const dir of scoresDirs) {
    loadScoresFromDir(dir, registry);
  }

  const adapterResolver = options.adapters ?? new LazyAdapterResolver();
  const piAdapter = new PiAdapter();
  const opencodeProvider = process.env.ORCHESTRON_OPENCODE_PROVIDER ?? 'opencode';
  const opencodeModelId = process.env.ORCHESTRON_OPENCODE_MODEL_ID ?? 'kimi-k2.5';
  const opencodeAdapter = new OpencodeAdapter({ embedded: { port: 0 }, provider: opencodeProvider, modelId: opencodeModelId });
  if (adapterResolver instanceof LazyAdapterResolver) {
    adapterResolver.register('pi', piAdapter);
    adapterResolver.register('opencode', opencodeAdapter);
  }

  const evaluator = options.evaluator ?? new HarnessEvaluator({ adapter: piAdapter });

  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: adapterResolver,
    evaluator,
  });

  return { store, registry, hall, scoresDirs };
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
