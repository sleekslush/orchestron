import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { waitForConcert } from '@orchestron/plugin-common';

export function waitForConcertTool(getOrchestron: () => Promise<import('@orchestron/plugin-common').Orchestron>) {
  return defineTool({
    name: 'orchestron_wait_for_concert',
    label: 'Wait for Orchestron Concert',
    description:
      'Block until an Orchestron concert reaches a terminal state (completed, failed, or cancelled). Streams progress updates in real time and returns the final concert status, movement history, and resource usage.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to wait for' }),
    }),
    promptSnippet: 'Wait for an Orchestron concert to finish',
    promptGuidelines: [
      'Use orchestron_wait_for_concert instead of repeatedly calling orchestron_get_concert_status when you need to wait for a concert to finish.',
      'The concertId is returned by orchestron_start_concert.',
      'This tool blocks until the concert is done, streaming progress updates.',
    ],
    async execute(_toolCallId, params, signal, onUpdate: AgentToolUpdateCallback<unknown>, _ctx) {
      const orchestron = await getOrchestron();
      const piOnUpdate = onUpdate
        ? (text: string) => onUpdate({ content: [{ type: 'text' as const, text }], details: {} })
        : undefined;
      const result = await waitForConcert(orchestron, params, piOnUpdate, signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
