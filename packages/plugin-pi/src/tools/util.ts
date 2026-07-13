export interface UsageView {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Convert internal usage (spend in micro-dollars) to a human-readable view
 * (spend in dollars). Tokens are already in whole units and returned as-is.
 */
export function toUsageView(usage: UsageView): UsageView {
  return {
    spend: usage.spend !== undefined ? usage.spend / 1_000_000 : undefined,
    tokens: usage.tokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
