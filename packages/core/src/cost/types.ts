/**
 * Source of a spend figure. `measured` is harness-reported exact cost;
 * `estimated` is derived from a pricing source (provider API or configured
 * table) using persisted token counts.
 */
export type SpendSource = 'measured' | 'estimated';

/** Result of resolving spend for one movement/concert. `null` = unresolvable → unknown. */
export interface CostResolution {
  /** Spend in microdollars. */
  spend: number;
  source: SpendSource;
}

/**
 * Everything needed to resolve spend. Mirrors the fields already persisted per
 * movement in Loge (`model`, `provider`, `inputTokens`, `outputTokens`),
 * plus the optional harness-measured `spend`.
 */
export interface CostResolutionInput {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Harness-reported spend in microdollars; takes precedence when present. */
  spend?: number;
}

/**
 * USD prices per token for one provider/model. `free` denotes a known-zero
 * price (e.g. OpenRouter free models) so we can resolve to $0.00 instead of
 * showing `unknown` for things that cost nothing.
 */
export type PricingData = {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
} | 'free';

/** A synchronous pricing lookup keyed by provider + model. */
export type PricingLookup = (
  provider: string | undefined,
  model: string | undefined,
) => PricingData | undefined;
