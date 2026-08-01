import { describe, it, expect } from 'vitest';
import { formatUsage, formatDollars } from '../output.js';

describe('formatUsage spend rendering', () => {
  it('renders measured spend with a plain $ prefix', () => {
    // 21400 micro = $0.0214
    expect(formatUsage({ spend: 21400, tokens: 225128, spendSource: 'measured' })).toBe(
      '$0.0214 / 225128 tokens',
    );
  });

  it('renders estimated spend with a ~$ prefix', () => {
    expect(formatUsage({ spend: 21400, tokens: 225128, spendSource: 'estimated' })).toBe(
      '~$0.0214 / 225128 tokens',
    );
  });

  it('renders unknown when spend is absent', () => {
    expect(formatUsage({ tokens: 225128 })).toBe('unknown / 225128 tokens');
  });

  it('renders zero spend', () => {
    expect(formatUsage({ spend: 0, tokens: 0, spendSource: 'estimated' })).toBe('~$0 / 0 tokens');
  });
});

describe('formatDollars', () => {
  it('trims trailing zeros', () => {
    expect(formatDollars(21400)).toBe('0.0214');
    expect(formatDollars(0)).toBe('0');
    expect(formatDollars(1_000_000)).toBe('1');
  });
});
