import type { Movement, MovementID } from '../types/score.js';
import type { MovementRecord } from '../types/concert.js';

export class PromptBuilder {
  private visitCounts = new Map<MovementID, number>();

  selectMovementPrompt(movement: Movement): string {
    if (!movement.prompt) return '';

    if (typeof movement.prompt === 'object') {
      const visits = this.visitCounts.get(movement.id) ?? 0;
      return visits === 0 ? movement.prompt.initial : movement.prompt.subsequent;
    }

    return movement.prompt;
  }

  recordVisit(movementId: MovementID): void {
    this.visitCounts.set(movementId, (this.visitCounts.get(movementId) ?? 0) + 1);
  }

  seedFromHistory(history: Array<{ movementId: MovementID }>): void {
    for (const record of history) {
      this.visitCounts.set(
        record.movementId,
        (this.visitCounts.get(record.movementId) ?? 0) + 1,
      );
    }
  }

  buildPrompt(
    movement: Movement,
    previousOutputs: Map<MovementID, MovementRecord>,
    contextShared: Record<string, unknown>,
  ): string {
    const raw = this.selectMovementPrompt(movement);
    if (!raw) return '';

    return this.resolveTemplate(raw, previousOutputs, contextShared);
  }

  resolveTemplate(
    template: string,
    previousOutputs: Map<MovementID, MovementRecord>,
    contextShared: Record<string, unknown>,
  ): string {
    let result = template;

    for (const [key, value] of Object.entries(contextShared)) {
      const placeholder = `{{context.${key}}}`;
      result = result.replaceAll(placeholder, this.stringify(value));
    }

    for (const [id, record] of previousOutputs) {
      const placeholder = `{{context.previousOutputs.${id}}}`;
      result = result.replaceAll(placeholder, record.output);
    }

    return result;
  }

  stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
