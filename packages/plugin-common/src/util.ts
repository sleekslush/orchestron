import { microToDollars } from '@orchestron/core';

export interface UsageView {
  spend?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function toUsageView(usage: UsageView): UsageView {
  return {
    spend: usage.spend !== undefined ? microToDollars(usage.spend) : undefined,
    tokens: usage.tokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}
