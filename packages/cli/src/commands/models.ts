import type { Orchestron, OrchestronModelEntry } from '../orchestron.js';
import { printOutput } from '../output.js';

export async function modelsCommandHandler(
  orchestron: Orchestron,
  harness: string | undefined,
  json: boolean,
): Promise<void> {
  const entries = await orchestron.listModels(harness);

  printOutput(json, entries, () => formatModelsHuman(entries));
}

function formatModelsHuman(entries: OrchestronModelEntry[]): string {
  if (entries.length === 0) {
    return 'No harnesses registered.';
  }

  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.error) {
      lines.push(`${entry.harness}: (error: ${entry.error})`);
      continue;
    }
    if (entry.models.length === 0) {
      lines.push(`${entry.harness}: (no models available)`);
      continue;
    }
    for (const { provider, model } of entry.models) {
      lines.push(`${entry.harness}: ${provider}/${model}`);
    }
  }
  return lines.join('\n');
}
