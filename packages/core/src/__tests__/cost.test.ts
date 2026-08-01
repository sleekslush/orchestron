import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCost, estimateSpend } from '../cost/resolver.js';
import type { PricingLookup } from '../cost/types.js';
import { CostResolver } from '../cost/cost-resolver.js';
import { OpenRouterPricing } from '../cost/openrouter-pricing.js';
import { convertPricingOverridesToLookup } from '../cost/table.js';

const openRouterModels = [
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    pricing: { prompt: '0.00000009', completion: '0.00000018' },
  },
  { id: 'openrouter/auto', pricing: { prompt: '0', completion: '0' } },
];

const noPricing: PricingLookup = () => undefined;

describe('resolveCost precedence', () => {
  it('measured spend always wins, marked measured', () => {
    const res = resolveCost({ spend: 5000, model: 'm', provider: 'p', inputTokens: 10, outputTokens: 5 }, noPricing);
    expect(res).toEqual({ spend: 5000, source: 'measured' });
  });

  it('falls back to pricing lookup when no measured spend', () => {
    const lookup: PricingLookup = () => ({ input: 1e-6, output: 2e-6 });
    const res = resolveCost({ model: 'm', provider: 'p', inputTokens: 1000, outputTokens: 500 }, lookup);
    expect(res!.source).toBe('estimated');
    // 1000*1e-6*1e6 + 500*2e-6*1e6 = 1000 + 1000 = 2000 micro
    expect(res!.spend).toBe(2000);
  });

  it('returns null (unknown) when no pricing source resolves', () => {
    expect(resolveCost({ model: 'm', provider: 'p', inputTokens: 10, outputTokens: 5 }, noPricing)).toBeNull();
  });

  it('resolves free pricing to $0.00 estimated', () => {
    const lookup: PricingLookup = () => 'free';
    expect(resolveCost({ model: 'm', inputTokens: 100, outputTokens: 100 }, lookup)).toEqual({
      spend: 0,
      source: 'estimated',
    });
  });

  it('returns null when neither model nor provider is present', () => {
    expect(resolveCost({ inputTokens: 10 }, noPricing)).toBeNull();
  });
});

describe('estimateSpend', () => {
  it('keeps precision for tiny per-token prices', () => {
    // OpenRouter-style pricing: 9e-8 input, 1.8e-7 output.
    const spend = estimateSpend({ inputTokens: 7942, outputTokens: 1565 }, {
      input: 9e-8,
      output: 1.8e-7,
    });
    // 7942*9e-8 + 1565*1.8e-7 = 0.00071478 + 0.0002817 = 0.00099648 dollars
    expect(spend).toBe(996);
  });
});

describe('CostResolver composition', () => {
  const fakeOpenRouter = {
    async get(model?: string) {
      if (model === 'deepseek/deepseek-v4-flash-0731') return { input: 9e-8, output: 1.8e-7 };
      if (model === 'free-model') return 'free';
      return undefined;
    },
  };

  it('measured take precedence over provider pricing', async () => {
    const r = new CostResolver({ openRouter: fakeOpenRouter });
    const res = await r.resolveCost({
      spend: 42,
      model: 'deepseek/deepseek-v4-flash-0731',
      provider: 'openrouter',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(res).toEqual({ spend: 42, source: 'measured' });
  });

  it('uses OpenRouter pricing when provider is openrouter and no measured cost', async () => {
    const r = new CostResolver({ openRouter: fakeOpenRouter });
    const res = await r.resolveCost({
      model: 'deepseek/deepseek-v4-flash-0731',
      provider: 'openrouter',
      inputTokens: 7942,
      outputTokens: 1565,
    });
    expect(res).toEqual({ spend: 996, source: 'estimated' });
  });

  it('falls back to configured table when OpenRouter has no entry', async () => {
    const r = new CostResolver({
      openRouter: fakeOpenRouter,
      configTable: convertPricingOverridesToLookup([
        { provider: 'openai', model: 'gpt-4o', inputPrice: 5e-6, outputPrice: 15e-6 },
      ]),
    });
    const res = await r.resolveCost({ model: 'gpt-4o', provider: 'openai', inputTokens: 1000, outputTokens: 500 });
    expect(res).toEqual({ spend: 12500, source: 'estimated' });
  });

  it('resolves free models (openrouter free) to zero', async () => {
    const r = new CostResolver({ openRouter: fakeOpenRouter });
    const res = await r.resolveCost({ model: 'free-model', provider: 'openrouter', inputTokens: 50, outputTokens: 50 });
    expect(res).toEqual({ spend: 0, source: 'estimated' });
  });

  it('resolves :free suffix models to zero even without a pricing source', async () => {
    const r = new CostResolver();
    expect(await r.resolveCost({ model: 'some/deepseek:free', inputTokens: 10, outputTokens: 10 })).toEqual({
      spend: 0,
      source: 'estimated',
    });
  });

  it('returns null (unknown) when nothing resolves', async () => {
    const r = new CostResolver();
    expect(await r.resolveCost({ model: 'mystery/m', inputTokens: 10, outputTokens: 5 })).toBeNull();
  });

  it('does not touch the network for a different provider when openrouter lookup errors', async () => {
    const throwing = {
      async get() {
        throw new Error('boom');
      },
    };
    const r = new CostResolver({
      openRouter: throwing,
      configTable: convertPricingOverridesToLookup([{ provider: 'anthropic', inputPrice: 3e-6, outputPrice: 15e-6 }]),
    });
    const res = await r.resolveCost({ model: 'claude-3-5-sonnet', provider: 'anthropic', inputTokens: 1000, outputTokens: 100 });
    expect(res).toEqual({ spend: 4500, source: 'estimated' });
  });
});

describe('convertPricingOverridesToLookup', () => {
  it('matches most-specific overrides first', () => {
    const lookup = convertPricingOverridesToLookup([
      { provider: 'openai', inputPrice: 1e-6, outputPrice: 2e-6 },
      { provider: 'openai', model: 'gpt-4', inputPrice: 3e-6, outputPrice: 6e-6 },
    ]);
    expect(lookup('openai', 'gpt-4')).toEqual({ input: 3e-6, output: 6e-6 });
    expect(lookup('openai', 'gpt-3.5')).toEqual({ input: 1e-6, output: 2e-6 });
    expect(lookup('anthropic', 'claude')).toBeUndefined();
  });

  it('handles free overrides', () => {
    const lookup = convertPricingOverridesToLookup([{ provider: 'openai', model: 'gpt-4o-mini', free: true }]);
    expect(lookup('openai', 'gpt-4o-mini')).toBe('free');
  });
});

describe('OpenRouterPricing caching', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-pricing-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and honors an on-disk cache (offline after first fetch)', async () => {
    const cachePath = join(dir, 'pricing-cache.json');
    let calls = 0;
    const src = new OpenRouterPricing({
      fetchFn: async () => {
        calls++;
        return openRouterModels;
      },
      cachePath,
    });

    const first = await src.get('deepseek/deepseek-v4-flash-0731');
    expect(first).toEqual({ input: 9e-8, output: 1.8e-7 });
    expect(calls).toBe(1);

    // A fresh instance (e.g. new process) loads from disk, no network.
    const fresh = new OpenRouterPricing({ fetchFn: async () => openRouterModels, cachePath });
    const second = await fresh.get('deepseek/deepseek-v4-flash-0731');
    expect(second).toEqual({ input: 9e-8, output: 1.8e-7 });
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      models: Record<string, unknown>;
    };
    expect(cached.models['deepseek/deepseek-v4-flash-0731']).toBeDefined();
  });

  it('persists free models distinctly from unknown', async () => {
    const cachePath = join(dir, 'pricing-cache.json');
    const src = new OpenRouterPricing({ fetchFn: async () => openRouterModels, cachePath });
    expect(await src.get('openrouter/auto')).toBe('free');
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(raw.models['openrouter/auto']).toBe('free');
  });

  it('returns undefined for unknown models without hitting network repeatedly while fresh', async () => {
    const src = new OpenRouterPricing({ fetchFn: async () => openRouterModels });
    expect(await src.get('nope/not-a-model')).toBeUndefined();
    expect(await src.get(undefined)).toBeUndefined();
    // sanity: known model still resolves
    expect(await src.get('deepseek/deepseek-v4-flash-0731')).toEqual({ input: 9e-8, output: 1.8e-7 });
  });
});
