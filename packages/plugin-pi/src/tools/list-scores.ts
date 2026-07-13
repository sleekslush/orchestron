import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { listScores } from '@orchestron/plugin-common';

export function listScoresTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_list_scores',
    label: 'List Orchestron Scores',
    description: 'List all registered Orchestron scores and their movements.',
    parameters: Type.Object({}),
    promptSnippet: 'List registered Orchestron workflow scores',
    promptGuidelines: [
      'Use orchestron_list_scores when the user asks what scores or workflows are available.',
    ],
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await listScores(orchestron);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
