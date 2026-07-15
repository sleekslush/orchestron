import type { Movement, MovementID } from '../types/score.js';
import type { MovementRecord } from '../types/concert.js';
import { tryParseStructuredFromText } from '../structured-output.js';

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

    // Sort by ID length (descending) to prevent shorter IDs from
    // accidentally matching the prefix of longer IDs when using regex.
    const sortedIds = [...previousOutputs.keys()].sort(
      (a, b) => b.length - a.length,
    );

    for (const id of sortedIds) {
      const record = previousOutputs.get(id)!;
      const escapedId = this.escapeRegex(id);

      // Matches:
      //   {{context.previousOutputs.<id>}}            — full output
      //   {{context.previousOutputs.<id>.<path>}}      — dot-notation into structured
      const regex = new RegExp(
        `\\{\\{context\\.previousOutputs\\.${escapedId}(?:\\.([^}]+))?\\}\\}`,
        'g',
      );

      result = result.replace(regex, (_match: string, dotPath: string | undefined) => {
        if (!dotPath) {
          // Simple {{context.previousOutputs.<id>}} — full text output
          return record.output;
        }

        // Dot-notation: traverse into structured data
        const parts = dotPath.split('.');
        let value: unknown = record.structured;

        // If structured data wasn't stored, fall back to parsing from output
        if (value === undefined || value === null) {
          value = tryParseStructuredFromText(record.output);
        }

        for (const part of parts) {
          if (value === null || value === undefined || typeof value !== 'object') {
            // Can't traverse further — leave placeholder as-is
            return _match;
          }
          if (Array.isArray(value)) {
            const index = Number(part);
            if (Number.isNaN(index) || index < 0 || index >= value.length) {
              return _match;
            }
            value = value[index];
          } else {
            value = (value as Record<string, unknown>)[part];
          }
        }

        if (value === undefined) {
          // Path not found — leave placeholder as-is for debugging
          return _match;
        }

        return this.stringify(value);
      });
    }

    return result;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
