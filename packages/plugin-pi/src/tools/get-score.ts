import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';
import { findScoreFile, readScoreFile, sanitizeScoreId } from './_score-helpers.js';

export interface GetScoreInput {
  scoreId: string;
}

export async function getScore(
  orchestron: Orchestron,
  input: GetScoreInput,
): Promise<{
  scoreId: string;
  yaml: string;
  path?: string;
  persisted: boolean;
}> {
  const scoreId = sanitizeScoreId(input.scoreId);
  const path = findScoreFile(orchestron.scoresDirs, scoreId);

  if (!path) {
    // Score might exist only in memory.
    try {
      orchestron.registry.get(scoreId);
      return { scoreId, yaml: '', path: undefined, persisted: false };
    } catch {
      throw new Error(`Score '${scoreId}' not found`);
    }
  }

  const yaml = readScoreFile(path);
  return { scoreId, yaml, path, persisted: true };
}

export function getScoreTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_get_score',
    label: 'Get Orchestron Score',
    description:
      'Get the full YAML and file path of an existing Orchestron score. Use this before editing to see the current definition. If the score only exists in memory, returns empty YAML.',
    parameters: Type.Object({
      scoreId: Type.String({ description: 'ID of the score to retrieve' }),
    }),
    promptSnippet: 'Get the full YAML definition of an Orchestron score',
    promptGuidelines: [
      'Use orchestron_get_score before editing a score so you have the complete current YAML.',
      'If the score is only in memory, the YAML field will be empty and the path will be missing.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await getScore(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
