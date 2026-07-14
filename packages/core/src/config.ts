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
export const DEFAULT_STORE_PATH = join(DEFAULT_CONFIG_DIR, 'store.db');
export const DEFAULT_SCORES_DIR = join(DEFAULT_CONFIG_DIR, 'scores');
export const LOCAL_SCORES_DIR = join(process.cwd(), '.orchestron', 'scores');

// ---------------------------------------------------------------------------
// Runtime validation helpers for the config boundary
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function parseString(value: unknown, fallback?: string): string | undefined {
  return isString(value) ? value : fallback;
}

function parseNumber(value: unknown, fallback?: number): number | undefined {
  return isNumber(value) ? value : fallback;
}

function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(isString).map(expandTilde);
  return strings.length > 0 ? strings : undefined;
}

function parseSubObject<T extends Record<string, unknown>>(
  value: unknown,
  fields: { [K in keyof T]: (v: unknown) => T[K] | undefined },
): T | undefined {
  if (!isObject(value)) return undefined;
  const result: Partial<T> = {};
  let hasAny = false;
  for (const [key, parser] of Object.entries(fields)) {
    const parsed = parser(value[key]);
    if (parsed !== undefined) {
      (result as Record<string, unknown>)[key] = parsed;
      hasAny = true;
    }
  }
  return hasAny ? (result as T) : undefined;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

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
  if (!isObject(raw)) return undefined;

  const config: OrchestronConfig = {};

  const storePath = parseString(raw.storePath);
  if (storePath !== undefined) config.storePath = expandTilde(storePath);

  const scoresDirs = parseStringArray(raw.scoresDirs);
  if (scoresDirs !== undefined) config.scoresDirs = scoresDirs;

  const tracesDir = parseString(raw.tracesDir);
  if (tracesDir !== undefined) config.tracesDir = expandTilde(tracesDir);

  const defaultHarness = parseString(raw.defaultHarness);
  if (defaultHarness !== undefined) config.defaultHarness = defaultHarness;

  const opencode = parseSubObject(raw.opencode, {
    provider: (v) => parseString(v),
    modelId: (v) => parseString(v),
    baseUrl: (v) => parseString(v),
    embedded: (v) => parseSubObject(v, {
      hostname: (v) => parseString(v),
      port: (v) => parseNumber(v),
      config: (v) => isObject(v) ? (v as Record<string, unknown>) : undefined,
    }),
  });
  if (opencode !== undefined) config.opencode = opencode;

  const pi = parseSubObject(raw.pi, {
    provider: (v) => parseString(v),
    modelId: (v) => parseString(v),
  });
  if (pi !== undefined) config.pi = pi;

  const evaluator = parseSubObject(raw.evaluator, {
    promptTemplate: (v) => parseString(v),
  });
  if (evaluator !== undefined) config.evaluator = evaluator;

  const dashboard = parseSubObject(raw.dashboard, {
    port: (v) => parseNumber(v),
  });
  if (dashboard !== undefined) config.dashboard = dashboard;

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
  const e = env ?? process.env;
  const fileConfig = loadConfigFile() ?? {};

  const storePath = firstDefined(
    options.storePath,
    e.ORCHESTRON_STORE_PATH,
    fileConfig.storePath,
    defaults.storePath,
  );

  const scoresDirs = firstDefined(
    options.scoresDirs,
    e.ORCHESTRON_SCORES_DIRS
      ? e.ORCHESTRON_SCORES_DIRS.split(',').map((s) => s.trim())
      : undefined,
    fileConfig.scoresDirs,
    defaults.scoresDirs,
  );

  const opencodeProvider = firstDefined(
    e.ORCHESTRON_OPENCODE_PROVIDER,
    fileConfig.opencode?.provider,
    'opencode',
  );

  const opencodeModelId = firstDefined(
    e.ORCHESTRON_OPENCODE_MODEL_ID,
    fileConfig.opencode?.modelId,
    'kimi-k2.5',
  );

  const piProvider = firstDefined(
    e.ORCHESTRON_PI_PROVIDER,
    fileConfig.pi?.provider,
    undefined,
  );

  const piModelId = firstDefined(
    e.ORCHESTRON_PI_MODEL_ID,
    fileConfig.pi?.modelId,
    undefined,
  );

  const defaultHarness = firstDefined(
    options.defaultHarness,
    e.ORCHESTRON_DEFAULT_HARNESS,
    fileConfig.defaultHarness,
    'pi',
  );

  return { storePath, scoresDirs, opencodeProvider, opencodeModelId, piProvider, piModelId, defaultHarness };
}

// ---------------------------------------------------------------------------
// Utility: return the first non-undefined value
// ---------------------------------------------------------------------------

function firstDefined<T>(...values: (T | undefined)[]): T {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  throw new Error('firstDefined: all values are undefined');
}
