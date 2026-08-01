import type { Movement } from '../types/score.js';
import type { MovementRecord, ResourceUsage } from '../types/concert.js';
import { ConstraintBreachError } from '../types/errors.js';
import { dollarsToMicro, microToDollars } from '../money.js';
import type { Program } from '../types/score.js';

export interface ConstraintResult {
  /**
   * Cumulative spend in microdollars, or `undefined` when spend is unmeasured
   * (the adapter/server reported no cost). An unknown cost must not be
   * indistinguishable from a genuinely free execution.
   */
  totalSpend: number | undefined;
  totalTokens: number;
}

export class ConstraintChecker {
  constructor(private program: Program | undefined) {}

  checkMovementLimit(count: number, movementId: string, concertId: string): void {
    const maxMovements = this.program?.maxMovements ?? 100;
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
    // Keep spend honest: only produce a numeric total when spend is
    // measurable. If neither side reports spend, leave it undefined so
    // downstream callers can render it as "unknown" rather than $0.00.
    const totalSpend =
      currentUsage.spend !== undefined || recordUsage.spend !== undefined
        ? (currentUsage.spend ?? 0) + (recordUsage.spend ?? 0)
        : undefined;
    const totalTokens = (currentUsage.tokens ?? 0) + (recordUsage.tokens ?? 0);
    const program = this.program ?? {};

    const maxSpendMicro = program.maxSpendDollars ? dollarsToMicro(program.maxSpendDollars) : undefined;
    // Only enforce spend limits when spend is measurable; an unmeasured cost
    // must not trip (or silently pass) a numeric budget.
    if (totalSpend !== undefined && maxSpendMicro && totalSpend > maxSpendMicro) {
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
