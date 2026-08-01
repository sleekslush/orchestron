import type { PricingData, PricingLookup } from './types.js';

/**
 * A single configured pricing override, e.g. for direct OpenAI/Anthropic keys
 * that expose no pricing in chat responses. Matches by `provider` and/or
 * `model` (both optional). A provider-only override applies to every model of
 * that provider; a model-only override applies to that model regardless of
 * provider; a fully-specified entry is the most specific and wins.
 */
export interface PricingOverride {
  provider?: string;
  model?: string;
  /** USD per input token. */
  inputPrice?: number;
  /** USD per output token. */
  outputPrice?: number;
  /** True for a known-free model (resolves to $0.00). */
  free?: boolean;
  /** Optional price-change marker, stored for documentation only. */
  effectiveFrom?: string;
}

/**
 * Convert a list of configured overrides into a `PricingLookup`. Specificity
 * order: exact (provider+model) > provider-only > model-only; `free` entries
 * resolve to `'free'`.
 */
export function convertPricingOverridesToLookup(
  overrides: PricingOverride[] | undefined,
): PricingLookup {
  const list = (overrides ?? []).filter(
    (o) => o.free || typeof o.inputPrice === 'number' || typeof o.outputPrice === 'number',
  );

  return (provider, model) => {
    const p = provider?.toLowerCase();
    const m = model?.toLowerCase();

    // Most specific first: exact provider+model match.
    const exact = list.find((o) => {
      const op = o.provider?.toLowerCase();
      const om = o.model?.toLowerCase();
      if (op !== undefined && om !== undefined) return op === p && om === m;
      if (op !== undefined) return false;
      if (om !== undefined) return false;
      return false;
    });
    if (exact) return toPricing(exact);

    // Provider-only override.
    const byProvider = list.find((o) => {
      const op = o.provider?.toLowerCase();
      return op !== undefined && o.model === undefined && op === p;
    });
    if (byProvider) return toPricing(byProvider);

    // Model-only override.
    const byModel = list.find((o) => {
      const om = o.model?.toLowerCase();
      return o.provider === undefined && om !== undefined && om === m;
    });
    if (byModel) return toPricing(byModel);

    return undefined;
  };
}

function toPricing(o: PricingOverride): PricingData {
  if (o.free) return 'free';
  const input = typeof o.inputPrice === 'number' ? o.inputPrice : 0;
  const output = typeof o.outputPrice === 'number' ? o.outputPrice : 0;
  if (input === 0 && output === 0) return 'free';
  return { input, output };
}
