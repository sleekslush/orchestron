import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Score, Movement, ScoreID, MovementID } from '../types/score.js';
import { ScoreValidationError } from '../types/errors.js';

export interface ScoreValidationResult {
  valid: boolean;
  errors: ScoreValidationError[];
}

export class ScoreRegistry {
  private scores = new Map<ScoreID, Score>();

  register(score: Score): void {
    const errors = this.validate(score);
    if (errors.length > 0) {
      throw errors[0];
    }
    this.scores.set(score.id, score);
  }

  registerMany(scores: Score[]): void {
    for (const score of scores) {
      this.register(score);
    }
  }

  get(id: ScoreID): Score {
    const score = this.scores.get(id);
    if (!score) {
      throw new ScoreValidationError(
        `Score '${id}' not found`,
        'INVALID_SCORE',
      );
    }
    return score;
  }

  list(): Score[] {
    return Array.from(this.scores.values());
  }

  remove(id: ScoreID): void {
    this.scores.delete(id);
  }

  loadFrom(path: string): void {
    if (!existsSync(path)) {
      throw new ScoreValidationError(
        `Score file not found: ${path}`,
        'INVALID_SCORE',
      );
    }
    const content = readFileSync(path, 'utf-8');
    const raw = yaml.load(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ScoreValidationError(
        `Invalid score YAML in: ${path}`,
        'INVALID_SCORE',
      );
    }
    this.register(raw as Score);
  }

  validate(score: Score): ScoreValidationError[] {
    const errors: ScoreValidationError[] = [];

    if (!score.id) {
      errors.push(new ScoreValidationError('Score must have an id', 'INVALID_SCORE'));
    }
    if (!score.version) {
      errors.push(new ScoreValidationError(`Score '${score.id}' must have a version`, 'INVALID_SCORE'));
    }
    if (!score.name) {
      errors.push(new ScoreValidationError(`Score '${score.id}' must have a name`, 'INVALID_SCORE'));
    }
    if (!score.movements || score.movements.length === 0) {
      errors.push(
        new ScoreValidationError(`Score '${score.id}' must have at least one movement`, 'INVALID_SCORE'),
      );
      return errors;
    }

    const movementIds = new Set(score.movements.map((m) => m.id));

    if (!movementIds.has(score.startMovement)) {
      errors.push(
        new ScoreValidationError(
          `Score '${score.id}': startMovement '${score.startMovement}' not found in movements`,
          'UNKNOWN_MOVEMENT',
        ),
      );
    }

    for (const m of score.movements) {
      if (m.prompt && typeof m.prompt === 'object') {
        if (typeof m.prompt.initial !== 'string' || typeof m.prompt.subsequent !== 'string' || !m.prompt.initial || !m.prompt.subsequent) {
          errors.push(
            new ScoreValidationError(
              `Score '${score.id}': movement '${m.id}' has a dual prompt but 'initial' and 'subsequent' must both be non-empty strings`,
              'INVALID_SCORE',
            ),
          );
        }
      }

      if (movementIds.has(m.id) && m.id !== score.startMovement) {
        const hasIncoming = score.movements.some((other) =>
          other.transitions.some((t) => t.to === m.id),
        );
        if (!hasIncoming) {
          errors.push(
            new ScoreValidationError(
              `Score '${score.id}': movement '${m.id}' is unreachable (no incoming transitions)`,
              'DANGLING_TRANSITION',
            ),
          );
        }
      }

      for (const t of m.transitions) {
        if (t.to !== '__end__' && t.to !== '__fail__' && !movementIds.has(t.to)) {
          errors.push(
            new ScoreValidationError(
              `Score '${score.id}': movement '${m.id}' has transition to unknown movement '${t.to}'`,
              'UNKNOWN_MOVEMENT',
            ),
          );
        }
      }
    }

    const cycle = this.detectCycle(score.movements, score.startMovement);
    if (cycle) {
      errors.push(
        new ScoreValidationError(
          `Score '${score.id}': cycle detected involving movements: ${cycle.join(' -> ')}`,
          'CYCLE_DETECTED',
        ),
      );
    }

    return errors;
  }

  private detectCycle(
    movements: Movement[],
    startId: MovementID,
  ): MovementID[] | null {
    const movementMap = new Map<MovementID, Movement>();
    for (const m of movements) {
      movementMap.set(m.id, m);
    }

    const graph = new Map<MovementID, MovementID[]>();
    for (const m of movements) {
      graph.set(
        m.id,
        m.transitions
          .filter((t) => t.to !== '__end__' && t.to !== '__fail__')
          .map((t) => t.to),
      );
    }

    function hasPathToTerminal(
      node: MovementID,
      visited: Set<MovementID>,
    ): boolean {
      if (visited.has(node)) return false;
      visited.add(node);
      const movement = movementMap.get(node);
      if (!movement) return false;
      if (movement.transitions.some((t) => t.to === '__end__' || t.to === '__fail__')) {
        return true;
      }
      const neighbors = graph.get(node) ?? [];
      return neighbors.some((n) => hasPathToTerminal(n, visited));
    }

    const visited = new Set<MovementID>();
    const inStack = new Set<MovementID>();
    const path: MovementID[] = [];

    function dfs(node: MovementID): MovementID[] | null {
      visited.add(node);
      inStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const result = dfs(neighbor);
          if (result) return result;
        } else if (inStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          if (cycle.some((n) => hasPathToTerminal(n, new Set()))) {
            path.pop();
            inStack.delete(node);
            return null;
          }
          return cycle;
        }
      }

      path.pop();
      inStack.delete(node);
      return null;
    }

    return dfs(startId);
  }
}
