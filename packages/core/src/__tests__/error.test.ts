import { describe, it, expect } from 'vitest';
import {
  OrchestronError,
  HarnessError,
  ConstraintBreachError,
  GoalEvalError,
  ScoreValidationError,
  ConductorPanic,
} from '../types/errors.js';

describe('OrchestronError', () => {
  it('constructs with message and code', () => {
    const err = new OrchestronError('oops', 'TEST_CODE');
    expect(err.message).toBe('oops');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('OrchestronError');
    expect(err.retryable).toBe(false);
    expect(err.concertId).toBeUndefined();
    expect(err.movementId).toBeUndefined();
  });

  it('constructs with all optional fields', () => {
    const err = new OrchestronError('msg', 'CODE', true, 'concert-1', 'movement-1');
    expect(err.retryable).toBe(true);
    expect(err.concertId).toBe('concert-1');
    expect(err.movementId).toBe('movement-1');
  });

  it('is instance of Error', () => {
    const err = new OrchestronError('x', 'X');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('HarnessError', () => {
  it('defaults to HARNESS_FAILURE and retryable', () => {
    const err = new HarnessError('harness failed');
    expect(err.code).toBe('HARNESS_FAILURE');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('HarnessError');
  });

  it('accepts HARNESS_TIMEOUT code', () => {
    const err = new HarnessError('timeout', 'HARNESS_TIMEOUT');
    expect(err.code).toBe('HARNESS_TIMEOUT');
  });

  it('is instance of OrchestronError', () => {
    const err = new HarnessError('x');
    expect(err).toBeInstanceOf(OrchestronError);
  });
});

describe('ConstraintBreachError', () => {
  it('constructs with limit, actual, and constraint fields', () => {
    const err = new ConstraintBreachError(
      'Spent too much', 'SPEND_LIMIT', 1000, 1500, 'maxSpend', 'concert-1',
    );
    expect(err.limit).toBe(1000);
    expect(err.actual).toBe(1500);
    expect(err.constraint).toBe('maxSpend');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('ConstraintBreachError');
  });

  it('accepts all four code variants', () => {
    for (const code of ['SPEND_LIMIT', 'TOKEN_LIMIT', 'MOVEMENT_LIMIT', 'DURATION_LIMIT'] as const) {
      const err = new ConstraintBreachError('msg', code, 10, 20, 'x');
      expect(err.code).toBe(code);
    }
  });

  it('is instance of OrchestronError', () => {
    const err = new ConstraintBreachError('m', 'SPEND_LIMIT', 1, 2, 'c');
    expect(err).toBeInstanceOf(OrchestronError);
  });
});

describe('GoalEvalError', () => {
  it('defaults to EVALUATOR_FAILURE and retryable', () => {
    const err = new GoalEvalError('eval failed');
    expect(err.code).toBe('EVALUATOR_FAILURE');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('GoalEvalError');
  });

  it('accepts AMBIGUOUS_RESULT code', () => {
    const err = new GoalEvalError('ambiguous', 'AMBIGUOUS_RESULT');
    expect(err.code).toBe('AMBIGUOUS_RESULT');
  });

  it('carries concertId and movementId', () => {
    const err = new GoalEvalError('m', 'EVALUATOR_FAILURE', 'c-1', 'm-1');
    expect(err.concertId).toBe('c-1');
    expect(err.movementId).toBe('m-1');
  });
});

describe('ScoreValidationError', () => {
  it('constructs with code and is not retryable', () => {
    const err = new ScoreValidationError('invalid score', 'INVALID_SCORE');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('ScoreValidationError');
  });

  it('accepts all four code variants', () => {
    for (const code of ['CYCLE_DETECTED', 'DANGLING_TRANSITION', 'UNKNOWN_MOVEMENT', 'INVALID_SCORE'] as const) {
      const err = new ScoreValidationError('msg', code);
      expect(err.code).toBe(code);
    }
  });
});

describe('ConductorPanic', () => {
  it('defaults to INTERNAL_ERROR and not retryable', () => {
    const err = new ConductorPanic('panic');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('ConductorPanic');
  });

  it('accepts STATE_CORRUPTION code and concertId', () => {
    const err = new ConductorPanic('state bad', 'STATE_CORRUPTION', 'c-1');
    expect(err.code).toBe('STATE_CORRUPTION');
    expect(err.concertId).toBe('c-1');
  });
});
