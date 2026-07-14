import type { Movement } from '../types/score.js';
import type { MovementRecord, ResourceUsage } from '../types/concert.js';
import { ConstraintBreachError } from '../types/errors.js';
import { dollarsToMicro, microToDollars } from '../money.js';
import type { Program } from '../types/score.js';

export interface ConstraintResult {
  totalSpend: number;
  totalTokens: number;
}

export class ConstraintChecker {
  constructor(private program: Program | undefined) {}

  checkMovementLimit(count: number, movementId: string, concertId: string): void {
    const maxMovements =
      this.program?.maxMovements ??
      this.program?.perSection?.['*']?.maxMovements ??
      100;
    if (count > maxMovements) {
      throw new ConstraintBreachError(
        `Movement limit exceeded: ${count} > ${maxMovements}`,
        'MOVEMENT_LIMIT',
        maxMovements,
        count,
        'maxMovements',
        concertId,
      );
    }
  }

  checkMovementConstraints(
    movement: Movement,
    record: MovementRecord,
    concertId: string,
  ): void {
    const movementMaxSpendMicro = movement.budget?.maxSpendDollars
      ? dollarsToMicro(movement.budget.maxSpendDollars)
      : undefined;
    if (movementMaxSpendMicro && (record.usage.spend ?? 0) > movementMaxSpendMicro) {
      const movementSpendDollars = microToDollars(record.usage.spend ?? 0);
      throw new ConstraintBreachError(
        `Movement spend limit exceeded: $${movementSpendDollars.toFixed(6)} > $${movement.budget!.maxSpendDollars!.toFixed(6)}`,
        'SPEND_LIMIT',
        movement.budget!.maxSpendDollars!,
        movementSpendDollars,
        'maxSpendDollars',
        concertId,
      );
    }
  }

  checkProgramConstraints(
    currentUsage: ResourceUsage,
    recordUsage: ResourceUsage,
    startedAt: number,
    concertId: string,
  ): ConstraintResult {
    const totalSpend = (currentUsage.spend ?? 0) + (recordUsage.spend ?? 0);
    const totalTokens = (currentUsage.tokens ?? 0) + (recordUsage.tokens ?? 0);
    const program = this.program ?? {};

    const maxSpendMicro = program.maxSpendDollars ? dollarsToMicro(program.maxSpendDollars) : undefined;
    if (maxSpendMicro && totalSpend > maxSpendMicro) {
      const totalSpendDollars = microToDollars(totalSpend);
      throw new ConstraintBreachError(
        `Spend limit exceeded: $${totalSpendDollars.toFixed(6)} > $${program.maxSpendDollars!.toFixed(6)}`,
        'SPEND_LIMIT',
        program.maxSpendDollars!,
        totalSpendDollars,
        'maxSpendDollars',
        concertId,
      );
    }
    if (program.maxDurationMs && startedAt > 0) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > program.maxDurationMs) {
        throw new ConstraintBreachError(
          `Duration limit exceeded: ${elapsed}ms > ${program.maxDurationMs}ms`,
          'DURATION_LIMIT',
          program.maxDurationMs,
          elapsed,
          'maxDurationMs',
          concertId,
        );
      }
    }

    return { totalSpend, totalTokens };
  }
}
