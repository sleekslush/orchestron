import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { getScore } from '@orchestron/plugin-common';

export function getScoreTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
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
