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
      worktree: Type.Optional(
        Type.Union([
          Type.Boolean(),
          Type.Object({
            baseBranch: Type.Optional(
              Type.String({ description: "Base branch for the worktree (default: score metadata.baseBranch or 'origin/main')" }),
            ),
            keep: Type.Optional(
              Type.Boolean({ description: 'Keep the worktree after the concert finishes' }),
            ),
          }),
        ], {
          description: 'Run the concert in an isolated git worktree',
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
      const { harness, ...rest } = params;
      const result = await startConcert(orchestron, harness ? { ...rest, harness } : rest, piOnUpdate);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
