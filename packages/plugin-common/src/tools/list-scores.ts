import type { Orchestron } from '../orchestron.js';
import { findScoreFile } from './_score-helpers.js';

export async function listScores(
  orchestron: Orchestron,
): Promise<{
  scores: Array<{
    id: string;
    name: string;
    version: string;
    description?: string;
    movements: string[];
    persisted: boolean;
  }>;
}> {
  const scores = orchestron.registry.list();
  return {
    scores: scores.map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      movements: s.movements.map((m) => m.id),
      persisted: findScoreFile(orchestron.scoresDirs, s.id) !== undefined,
    })),
  };
}
