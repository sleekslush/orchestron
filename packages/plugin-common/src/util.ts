export interface UsageView {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function toUsageView(usage: UsageView): UsageView {
  return {
    spend: usage.spend !== undefined ? usage.spend / 1_000_000 : undefined,
    tokens: usage.tokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
