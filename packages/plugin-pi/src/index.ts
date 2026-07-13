import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HarnessAdapter } from '@orchestron/core';
import { createOrchestron, type Orchestron, type OrchestronOptions } from '@orchestron/plugin-common';
import { PiAdapter } from '@orchestron/adapter-pi';
import { OpencodeAdapter } from '@orchestron/adapter-opencode';
import { startConcertTool } from './tools/start-concert.js';
import { getConcertStatusTool } from './tools/get-status.js';
import { listConcertsTool } from './tools/list-concerts.js';
import { pauseConcertTool } from './tools/pause-concert.js';
import { cancelConcertTool } from './tools/cancel-concert.js';
import { listScoresTool } from './tools/list-scores.js';
import { createScoreTool } from './tools/create-score.js';
import { editScoreTool } from './tools/edit-score.js';
import { getScoreTool } from './tools/get-score.js';
import { waitForConcertTool } from './tools/wait-for-concert.js';

export interface OrchestronPluginConfig extends OrchestronOptions {}

export default function orchestronPlugin(
  pi: ExtensionAPI,
  config: OrchestronPluginConfig = {},
): void {
  let orchestronPromise: Promise<Orchestron> | undefined;

  function getOrchestron(): Promise<Orchestron> {
    if (!orchestronPromise) {
      orchestronPromise = createOrchestron({
        ...config,
        defaultHarness: config.defaultHarness ?? 'pi',
        adapters: config.adapters ?? new Map<string, HarnessAdapter>([
          ['pi', new PiAdapter()],
          ['opencode', new OpencodeAdapter({ embedded: { port: 0 } })],
        ]),
      }).catch((err) => {
        orchestronPromise = undefined;
        throw err;
      });
    }
    return orchestronPromise;
  }

  pi.on('session_shutdown', async () => {
    if (!orchestronPromise) return;
    const orchestron = await orchestronPromise.catch(() => undefined);
    orchestronPromise = undefined;
    if (orchestron) {
      try {
        orchestron.store.close();
      } catch {
        // ignore
      }
    }
  });

  pi.registerTool(startConcertTool(getOrchestron));
  pi.registerTool(getConcertStatusTool(getOrchestron));
  pi.registerTool(listConcertsTool(getOrchestron));
  pi.registerTool(pauseConcertTool(getOrchestron));
  pi.registerTool(cancelConcertTool(getOrchestron));
  pi.registerTool(listScoresTool(getOrchestron));
  pi.registerTool(createScoreTool(getOrchestron));
  pi.registerTool(editScoreTool(getOrchestron));
  pi.registerTool(getScoreTool(getOrchestron));
  pi.registerTool(waitForConcertTool(getOrchestron));
}
