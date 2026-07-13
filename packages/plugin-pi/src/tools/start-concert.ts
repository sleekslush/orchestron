import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { startConcert } from '@orchestron/plugin-common';

export function startConcertTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_start_concert',
    label: 'Start Orchestron Concert',
    description:
      'Start a new Orchestron concert from a registered score. The concert runs in the background and can be monitored with orchestron_get_concert_status.',
    parameters: Type.Object({
      scoreId: Type.String({ description: 'ID of the registered score to run' }),
      context: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Optional initial context values for the concert',
        }),
      ),
    }),
    promptSnippet: 'Start an Orchestron workflow concert from a registered score',
    promptGuidelines: [
      'Use orchestron_start_concert when the user asks to run a workflow, score, or concert.',
      'Pass the scoreId exactly as registered and any context values the score expects.',
    ],
    async execute(_toolCallId, params, _signal, onUpdate: AgentToolUpdateCallback<unknown>, _ctx) {
      const orchestron = await getOrchestron();
      const piOnUpdate = onUpdate
        ? (text: string) => onUpdate({ content: [{ type: 'text' as const, text }], details: {} })
        : undefined;
      const result = await startConcert(orchestron, params, piOnUpdate);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
