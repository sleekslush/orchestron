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
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`=== ${entry.harness} ===`);
    if (entry.error) {
      lines.push(`  (error: ${entry.error})`);
      continue;
    }
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
