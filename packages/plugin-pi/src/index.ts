import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createOrchestron, type Orchestron, type OrchestronOptions } from './orchestron.js';
import { startConcertTool } from './tools/start-concert.js';
import { getConcertStatusTool } from './tools/get-status.js';
import { listConcertsTool } from './tools/list-concerts.js';
import { pauseConcertTool } from './tools/pause-concert.js';
import { cancelConcertTool } from './tools/cancel-concert.js';
import { listScoresTool } from './tools/list-scores.js';

export interface OrchestronPluginConfig extends OrchestronOptions {}

export default function orchestronPlugin(
  pi: ExtensionAPI,
  config: OrchestronPluginConfig = {},
): void {
  let orchestronPromise: Promise<Orchestron> | undefined;

  function getOrchestron(): Promise<Orchestron> {
    if (!orchestronPromise) {
      orchestronPromise = createOrchestron(config).catch((err) => {
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
}
