import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { startConcert } from '@orchestron/plugin-common';

export function startConcertTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_start_concert',
    label: 'Start Orchestron Concert',
    description:
      'Create and kick off a new Orchestron concert from a registered score. Returns immediately with the concert id and post-kickoff status; the concert runs in the background. This tool does not stream or block — use orchestron_wait_for_concert to observe it.',
    parameters: Type.Object({
      scoreId: Type.String({ description: 'ID of the registered score to run' }),
      context: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Optional initial context values for the concert',
        }),
      ),
      harness: Type.Optional(
        Type.String({
          description: 'Optional explicit harness to use for the concert. Overrides the score\'s default harness.',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: 'Optional working directory for the concert (tool calls land here). Defaults to the current working directory.',
        }),
      ),
    }),
    promptSnippet: 'Start an Orchestron workflow concert from a registered score',
    promptGuidelines: [
      'Use orchestron_start_concert when the user asks to run a workflow, score, or concert.',
      'Pass the scoreId exactly as registered and any context values the score expects.',
      'orchestron_start_concert creates the concert and returns immediately; it does not wait.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const { harness, ...rest } = params;
      const result = await startConcert(orchestron, harness ? { ...rest, harness } : rest);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
