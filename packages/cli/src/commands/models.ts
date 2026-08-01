import type { Orchestron } from '../orchestron.js';
import { printOutput } from '../output.js';

export async function modelsCommandHandler(
  orchestron: Orchestron,
  harness: string | undefined,
  json: boolean,
): Promise<void> {
  const entries = await orchestron.listModels(harness);

  printOutput(json, entries, () => formatModelsHuman(entries));
}

function formatModelsHuman(
  entries: Array<{ harness: string; models: Array<{ provider: string; model: string }> }>,
): string {
  if (entries.length === 0) {
    return 'No harnesses registered.';
  }

  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.harness}:`);
    if (entry.models.length === 0) {
      lines.push('  (no models available)');
      continue;
    }
    for (const { provider, model } of entry.models) {
      lines.push(`  ${provider}/${model}`);
    }
  }
  return lines.join('\n');
}
