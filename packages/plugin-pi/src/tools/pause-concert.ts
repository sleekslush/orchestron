import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Orchestron } from '../orchestron.js';

export interface PauseConcertInput {
  concertId: string;
}

export async function pauseConcert(
  orchestron: Orchestron,
  input: PauseConcertInput,
): Promise<{ concertId: string; status: string }> {
  const conductor = await orchestron.hall.loadConcert(input.concertId);
  if (!conductor) {
    throw new Error(`Concert '${input.concertId}' not found`);
  }

  await conductor.pause();
  const state = await conductor.getState();
  return { concertId: state.id, status: state.status };
}

export function pauseConcertTool(getOrchestron: () => Promise<Orchestron>) {
  return defineTool({
    name: 'orchestron_pause_concert',
    label: 'Pause Orchestron Concert',
    description: 'Pause a running Orchestron concert.',
    parameters: Type.Object({
      concertId: Type.String({ description: 'ID of the concert to pause' }),
    }),
    promptSnippet: 'Pause a running Orchestron concert',
    promptGuidelines: [
      'Use orchestron_pause_concert when the user asks to pause or stop a running concert temporarily.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orchestron = await getOrchestron();
      const result = await pauseConcert(orchestron, params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
