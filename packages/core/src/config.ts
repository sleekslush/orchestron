import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OrchestronConfig {
  storePath?: string;
  scoresDirs?: string[];
  tracesDir?: string;
  defaultHarness?: string;
  opencode?: {
    provider?: string;
    modelId?: string;
    baseUrl?: string;
    embedded?: {
      hostname?: string;
      port?: number;
      config?: Record<string, unknown>;
    };
  };
  pi?: {
    provider?: string;
    modelId?: string;
  };
  evaluator?: {
    promptTemplate?: string;
  };
  dashboard?: {
    port?: number;
  };
}

export interface ResolvedOrchestronConfig {
  storePath: string;
  scoresDirs: string[];
  opencodeProvider: string;
  opencodeModelId: string;
  piProvider?: string;
  piModelId?: string;
  defaultHarness: string;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), '.orchestron');
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json');

function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function loadConfigFile(path?: string): OrchestronConfig | undefined {
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(configPath)) return undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(content);
    return normalizeConfig(raw);
  } catch {
    return undefined;
  }
}

function normalizeConfig(raw: unknown): OrchestronConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const input = raw as Record<string, unknown>;
  const config: OrchestronConfig = {};

  if (typeof input.storePath === 'string') {
    config.storePath = expandTilde(input.storePath);
  }
  if (Array.isArray(input.scoresDirs)) {
    config.scoresDirs = input.scoresDirs.map((d) =>
      typeof d === 'string' ? expandTilde(d) : String(d),
    );
  }
  if (typeof input.tracesDir === 'string') {
    config.tracesDir = expandTilde(input.tracesDir);
  }
  if (typeof input.defaultHarness === 'string') {
    config.defaultHarness = input.defaultHarness;
  }
  if (input.opencode && typeof input.opencode === 'object') {
    const oc = input.opencode as Record<string, unknown>;
    config.opencode = {};
    if (typeof oc.provider === 'string') config.opencode.provider = oc.provider;
    if (typeof oc.modelId === 'string') config.opencode.modelId = oc.modelId;
    if (typeof oc.baseUrl === 'string') config.opencode.baseUrl = oc.baseUrl;
    if (oc.embedded && typeof oc.embedded === 'object') {
      const emb = oc.embedded as Record<string, unknown>;
      config.opencode.embedded = {};
      if (typeof emb.hostname === 'string') config.opencode.embedded.hostname = emb.hostname;
      if (typeof emb.port === 'number') config.opencode.embedded.port = emb.port;
      if (emb.config && typeof emb.config === 'object') {
        config.opencode.embedded.config = emb.config as Record<string, unknown>;
      }
    }
  }
  if (input.pi && typeof input.pi === 'object') {
    const pi = input.pi as Record<string, unknown>;
    config.pi = {};
    if (typeof pi.provider === 'string') config.pi.provider = pi.provider;
    if (typeof pi.modelId === 'string') config.pi.modelId = pi.modelId;
  }
  if (input.evaluator && typeof input.evaluator === 'object') {
    const ev = input.evaluator as Record<string, unknown>;
    config.evaluator = {};
    if (typeof ev.promptTemplate === 'string') config.evaluator.promptTemplate = ev.promptTemplate;
  }
  if (input.dashboard && typeof input.dashboard === 'object') {
    const db = input.dashboard as Record<string, unknown>;
    config.dashboard = {};
    if (typeof db.port === 'number') config.dashboard.port = db.port;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export function resolveOrchestronConfig(
  options: { storePath?: string; scoresDirs?: string[]; defaultHarness?: string },
  defaults: {
    storePath: string;
    scoresDirs: string[];
  },
  env?: Record<string, string | undefined>,
): ResolvedOrchestronConfig {
  const e = env ?? (process.env as Record<string, string | undefined>);
  const fileConfig = loadConfigFile() ?? {};

  const storePath =
    options.storePath ??
    e.ORCHESTRON_STORE_PATH ??
    fileConfig.storePath ??
    defaults.storePath;

  const scoresDirs =
    options.scoresDirs ??
    (e.ORCHESTRON_SCORES_DIRS
      ? e.ORCHESTRON_SCORES_DIRS.split(',').map((s) => s.trim())
      : undefined) ??
    fileConfig.scoresDirs ??
    defaults.scoresDirs;

  const opencodeProvider =
    e.ORCHESTRON_OPENCODE_PROVIDER ??
    fileConfig.opencode?.provider ??
    'opencode';

  const opencodeModelId =
    e.ORCHESTRON_OPENCODE_MODEL_ID ??
    fileConfig.opencode?.modelId ??
    'kimi-k2.5';

  const piProvider =
    e.ORCHESTRON_PI_PROVIDER ??
    fileConfig.pi?.provider;

  const piModelId =
    e.ORCHESTRON_PI_MODEL_ID ??
    fileConfig.pi?.modelId;

  const defaultHarness =
    options.defaultHarness ??
    e.ORCHESTRON_DEFAULT_HARNESS ??
    fileConfig.defaultHarness ??
    'pi';

  return { storePath, scoresDirs, opencodeProvider, opencodeModelId, piProvider, piModelId, defaultHarness };
}
