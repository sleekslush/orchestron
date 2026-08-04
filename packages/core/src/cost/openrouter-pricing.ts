import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PricingData } from './types.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenRouterRemoteModel {
  id: string;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
}

/** Source of OpenRouter pricing, with in-memory + on-disk caching. */
export interface OpenRouterPricingSource {
  /**
   * @returns `PricingData`, `'free'` for a known-zero model, or `undefined`
   *   when the model's price is unknown.
   */
  get(model: string | undefined): Promise<PricingData | undefined>;
}

export async function fetchOpenRouterModels(
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<OpenRouterRemoteModel[]> {
  const res = await fetchFn(OPENROUTER_MODELS_URL, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter pricing lookup failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: OpenRouterRemoteModel[] };
  return json.data ?? [];
}

function parsePrice(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizePricing(
  pricing: OpenRouterRemoteModel['pricing'],
): PricingData | undefined {
  if (!pricing) return undefined;
  const prompt = parsePrice(pricing.prompt);
  const completion = parsePrice(pricing.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  if (prompt === 0 && completion === 0) return 'free';
  return { input: prompt, output: completion };
}

interface CacheFileShape {
  fetchedAt?: number;
  models?: Record<string, Exclude<PricingData, 'free'> | 'free'>;
}

export interface OpenRouterPricingOptions {
  /** Override for tests; defaults to a real fetch against the public API. */
  fetchFn?: () => Promise<OpenRouterRemoteModel[]>;
  /** Optional on-disk cache path (e.g. `~/.orchestron/pricing-cache.json`). */
  cachePath?: string;
  /** Freshness TTL before refreshing from the network. */
  ttlMs?: number;
}

/**
 * OpenRouter per-model pricing with two levels of caching:
 *  - an in-memory `Map` refreshed after a TTL (default 24h), so repeated
 *    `list`/`status` reads never block on the network while warm, and
 *  - a small JSON cache on disk, so reads work offline after the first fetch.
 * Resolution is always async and failure-tolerant: a network error falls back
 * to whatever cache exists (possibly none → `unknown`).
 */
export class OpenRouterPricing implements OpenRouterPricingSource {
  private readonly cache = new Map<string, PricingData>();
  private fetchedAt = 0;
  private loadPromise?: Promise<void>;
  private readonly fetchFn: () => Promise<OpenRouterRemoteModel[]>;
  private readonly cachePath?: string;
  private readonly ttlMs: number;

  constructor(options: OpenRouterPricingOptions = {}) {
    this.fetchFn = options.fetchFn ?? (() => fetchOpenRouterModels());
    this.cachePath = options.cachePath;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.cachePath) this.loadFromDisk();
  }

  async get(model: string | undefined): Promise<PricingData | undefined> {
    if (!model) return undefined;
    if (this.cache.has(model)) return this.cache.get(model);
    await this.ensureLoaded();
    return this.cache.get(model);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.fetchedAt && Date.now() - this.fetchedAt < this.ttlMs) return;
    if (!this.loadPromise) {
      this.loadPromise = this.load().finally(() => {
        this.loadPromise = undefined;
      });
    }
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const models = await this.fetchFn();
      for (const m of models) {
        const price = normalizePricing(m.pricing);
        if (price !== undefined) this.cache.set(m.id, price);
      }
      this.fetchedAt = Date.now();
      this.saveToDisk();
    } catch {
      // Network failure / offline. Leave `fetchedAt` unchanged: when we have a
      // fresh disk cache it is already honored by ensureLoaded; otherwise the
      // next read retries instead of waiting out the TTL.
    }
  }

  private loadFromDisk(): void {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as CacheFileShape;
      if (typeof raw.fetchedAt === 'number') this.fetchedAt = raw.fetchedAt;
      for (const [key, value] of Object.entries(raw.models ?? {})) {
        this.cache.set(key, value === 'free' ? 'free' : value);
      }
    } catch {
      // Corrupt/partial cache — ignore and refetch.
    }
  }

  private saveToDisk(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const models: Record<string, Exclude<PricingData, 'free'> | 'free'> = {};
      for (const [key, value] of this.cache) models[key] = value;
      const payload: CacheFileShape = { fetchedAt: this.fetchedAt, models };
      writeFileSync(this.cachePath, JSON.stringify(payload));
    } catch {
      // Best-effort persistence; ignore write failures.
    }
  }
}
