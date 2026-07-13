import { describe, it, expect } from 'vitest';
import { toUsageView, type UsageView } from '@orchestron/plugin-common';

describe('toUsageView', () => {
  it('converts spend from micro-dollars to dollars', () => {
    const input: UsageView = { spend: 1_000_000, tokens: 100 };
    expect(toUsageView(input)).toEqual({ spend: 1, tokens: 100 });
  });

  it('handles zero spend', () => {
    const input: UsageView = { spend: 0, tokens: 50 };
    expect(toUsageView(input)).toEqual({ spend: 0, tokens: 50 });
  });

  it('handles undefined spend', () => {
    const input: UsageView = { tokens: 100 };
    expect(toUsageView(input)).toEqual({ tokens: 100 });
  });

  it('handles objects with only token fields', () => {
    const input: UsageView = { tokens: 200, inputTokens: 150, outputTokens: 50 };
    expect(toUsageView(input)).toEqual({ tokens: 200, inputTokens: 150, outputTokens: 50 });
  });
});
