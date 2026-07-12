export class OrchestronError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
    public readonly concertId?: string,
    public readonly movementId?: string,
  ) {
    super(message);
    this.name = 'OrchestronError';
  }
}

export class HarnessError extends OrchestronError {
  constructor(
    message: string,
    code: 'HARNESS_FAILURE' | 'HARNESS_TIMEOUT' = 'HARNESS_FAILURE',
    concertId?: string,
    movementId?: string,
  ) {
    super(message, code, true, concertId, movementId);
    this.name = 'HarnessError';
  }
}

export class ConstraintBreachError extends OrchestronError {
  constructor(
    message: string,
    code: 'SPEND_LIMIT' | 'TOKEN_LIMIT' | 'MOVEMENT_LIMIT' | 'DURATION_LIMIT',
    public readonly limit: number,
    public readonly actual: number,
    public readonly constraint: string,
    concertId?: string,
  ) {
    super(message, code, false, concertId);
    this.name = 'ConstraintBreachError';
  }
}

export class GoalEvalError extends OrchestronError {
  constructor(
    message: string,
    code: 'EVALUATOR_FAILURE' | 'AMBIGUOUS_RESULT' = 'EVALUATOR_FAILURE',
    concertId?: string,
    movementId?: string,
  ) {
    super(message, code, true, concertId, movementId);
    this.name = 'GoalEvalError';
  }
}

export class ScoreValidationError extends OrchestronError {
  constructor(
    message: string,
    code: 'CYCLE_DETECTED' | 'DANGLING_TRANSITION' | 'UNKNOWN_MOVEMENT' | 'INVALID_SCORE',
  ) {
    super(message, code, false);
    this.name = 'ScoreValidationError';
  }
}

export class ConductorPanic extends OrchestronError {
  constructor(
    message: string,
    code: 'INTERNAL_ERROR' | 'STATE_CORRUPTION' = 'INTERNAL_ERROR',
    concertId?: string,
  ) {
    super(message, code, false, concertId);
    this.name = 'ConductorPanic';
  }
}
