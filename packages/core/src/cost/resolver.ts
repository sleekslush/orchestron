import { MICRO_DOLLARS_PER_DOLLAR } from '../money.js';
import type { CostResolution, CostResolutionInput, PricingData, PricingLookup } from './types.js';

/**
 * Compute estimated spend in microdollars from persisted token counts and a
 * per-token USD price. Prices are multiplied per-token *before* converting to
 * microdollars so tiny per-token values (e.g. 9e-8) retain precision instead of
 * being snapped to 0 by an up-front rounding.
 */
export function estimateSpend(
  input: Pick<CostResolutionInput, 'inputTokens' | 'outputTokens'>,
  price: Exclude<PricingData, 'free'>,
): number {
  return Math.round(
    (input.inputTokens ?? 0) * price.input * MICRO_DOLLARS_PER_DOLLAR +
      (input.outputTokens ?? 0) * price.output * MICRO_DOLLARS_PER_DOLLAR,
  );
}

/**
 * Pure spend resolver implementing the precedence: measured → pricing lookup →
 * unknown. Returns `null` when nothing can resolve spend (rendered as
 * `unknown`), preserving today's last-resort behavior.
 *
 * This sync helper is intentionally kept alongside the async `CostResolver`,
 * which layers the async per-provider sources (OpenRouter network fetch,
 * configured table, free-marker) on top of the same measured-first ordering.
 * The duplication is deliberate: `resolveCost` is the fast, dependency-free
 * core exercised by unit tests, while `CostResolver` owns I/O and caching.
 */
export function resolveCost(
  input: CostResolutionInput,
  lookup: PricingLookup,
): CostResolution | null {
  // 1. Measured — harness-reported cost, highest trust.
  if (input.spend !== undefined) {
    return { spend: input.spend, source: 'measured' };
  }

  // Without a model/provider there is no pricing dimension to consult.
  if (!input.model && !input.provider) return null;

  try {
    // 2+. Provider pricing (via the injected lookup) → free → unknown.
    const price = lookup(input.provider, input.model);
    if (price === undefined) return null;
    if (price === 'free') return { spend: 0, source: 'estimated' };
    return { spend: estimateSpend(input, price), source: 'estimated' };
  } catch {
    return null;
  }
}
