import type { CostResolution, CostResolutionInput } from './types.js';
import type { PricingLookup } from './types.js';
import type { OpenRouterPricingSource } from './openrouter-pricing.js';
import { estimateSpend } from './resolver.js';

export interface CostResolverOptions {
  /** Provider pricing source (currently OpenRouter). */
  openRouter?: OpenRouterPricingSource;
  /** Configured static pricing table (for providers without a public API). */
  configTable?: PricingLookup;
}

/**
 * Composed cost resolver implementing per-provider spend strategy:
 *
 *   measured (harness-reported) → provider pricing (OpenRouter API) →
 *   configured table → free-model marker → unknown (null).
 *
 * All estimation is async-tolerant: a provider pricing failure falls through
 * to the configured table, and only returns `null` (unknown) when no source
 * could resolve spend.
 */
export class CostResolver {
  private readonly openRouter?: OpenRouterPricingSource;
  private readonly configTable?: PricingLookup;

  constructor(options: CostResolverOptions = {}) {
    this.openRouter = options.openRouter;
    this.configTable = options.configTable;
  }

  async resolveCost(input: CostResolutionInput): Promise<CostResolution | null> {
    // 1. Measured — harness-reported cost is the source of truth.
    if (input.spend !== undefined) {
      return { spend: input.spend, source: 'measured' };
    }
    if (!input.model && !input.provider) return null;

    const provider = (input.provider ?? '').toLowerCase();

    // 2. Provider pricing (OpenRouter public API).
    if (this.openRouter && (provider === 'openrouter' || provider === '')) {
      try {
        const price = await this.openRouter.get(input.model);
        if (price !== undefined) {
          return price === 'free'
            ? { spend: 0, source: 'estimated' }
            : { spend: estimateSpend(input, price), source: 'estimated' };
        }
      } catch {
        // fall through to configured table / unknown
      }
    }

    // 3. Configured static pricing table.
    if (this.configTable) {
      const price = this.configTable(input.provider, input.model);
      if (price !== undefined) {
        return price === 'free'
          ? { spend: 0, source: 'estimated' }
          : { spend: estimateSpend(input, price), source: 'estimated' };
      }
    }

    // 3.5 Known-free models by convention (`:free` suffix, e.g. openrouter:free).
    if (input.model?.toLowerCase().includes(':free')) {
      return { spend: 0, source: 'estimated' };
    }

    // 4. Nothing → unknown.
    return null;
  }
}
