import { describe, it, expect } from 'vitest';
import { ConstraintChecker } from '../conductor/constraint-checker.js';
import { ConstraintBreachError } from '../types/errors.js';
import type { Program, Movement } from '../types/score.js';

function checker(program?: Program): ConstraintChecker {
  return new ConstraintChecker(program);
}

function movement(overrides: Partial<Movement> = {}): Movement {
  return {
    id: 'a',
    name: 'A',
    section: 'execution',
    description: 'A',
    harness: 'fake',
    prompt: 'A',
    goal: { description: 'done', strategy: 'llm_judge' },
    transitions: [{ to: '__end__', on: 'success' }],
    ...overrides,
  };
}

describe('ConstraintChecker.checkProgramConstraints', () => {
  it('keeps spend undefined when neither side reports a cost', () => {
    const result = checker().checkProgramConstraints({}, {}, 0, 'c1');
    expect(result.totalSpend).toBeUndefined();
    expect(result.totalTokens).toBe(0);
  });

  it('keeps spend undefined when only tokens are reported', () => {
    const result = checker().checkProgramConstraints(
      {},
      { tokens: 100 },
      0,
      'c1',
    );
    expect(result.totalSpend).toBeUndefined();
    expect(result.totalTokens).toBe(100);
  });

  it('accumulates spend when only the current usage reports a cost', () => {
    const result = checker().checkProgramConstraints({ spend: 10 }, {}, 0, 'c1');
    expect(result.totalSpend).toBe(10);
  });

  it('accumulates spend when only the record reports a cost', () => {
    const result = checker().checkProgramConstraints({}, { spend: 10 }, 0, 'c1');
    expect(result.totalSpend).toBe(10);
  });

  it('sums spend and tokens when both sides report them', () => {
    const result = checker().checkProgramConstraints(
      { spend: 10, tokens: 100 },
      { spend: 5, tokens: 50 },
      0,
      'c1',
    );
    expect(result.totalSpend).toBe(15);
    expect(result.totalTokens).toBe(150);
  });

  it('does not enforce a spend limit when spend is unmeasured', () => {
    const c = checker({ maxSpendDollars: 1.5 });
    // maxSpendDollars = $1.5 => 1_500_000 micro; no spend measured at all.
    expect(() => c.checkProgramConstraints({}, { tokens: 100 }, 0, 'c1')).not.toThrow();
  });

  it('enforces a spend limit only when cumulative spend is measurable', () => {
    const c = checker({ maxSpendDollars: 1.5 });
    expect(() =>
      c.checkProgramConstraints({ spend: 1_000_000 }, { spend: 600_000 }, 0, 'c1'),
    ).toThrow(ConstraintBreachError);
  });

  it('does not throw a spend breach when measured spend is within budget', () => {
    const c = checker({ maxSpendDollars: 5 });
    expect(() =>
      c.checkProgramConstraints({ spend: 100 }, { spend: 200 }, 0, 'c1'),
    ).not.toThrow();
  });
});

describe('ConstraintChecker.checkMovementConstraints', () => {
  it('does not enforce a movement spend limit when spend is unmeasured', () => {
    const c = checker();
    const m = movement({ budget: { maxSpendDollars: 0.5 } });
    expect(() =>
      c.checkMovementConstraints(
        m,
        { usage: { tokens: 100 } } as any,
        'c1',
      ),
    ).not.toThrow();
  });

  it('enforces a movement spend limit when spend is measured', () => {
    const c = checker();
    const m = movement({ budget: { maxSpendDollars: 0.5 } });
    expect(() =>
      c.checkMovementConstraints(
        m,
        { usage: { spend: 600_000 } } as any,
        'c1',
      ),
    ).toThrow(ConstraintBreachError);
  });
});
