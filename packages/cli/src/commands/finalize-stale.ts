import type { Orchestron } from '../orchestron.js';
import type { ConcertEvent } from '@orchestron/core';
import {
  finalizeStaleConcert,
  finalizeAllStale,
  type FinalizeStaleResult,
} from '@orchestron/core';
import { printOutput } from '../output.js';

/**
 * Record a `concert:failed` event for an externally-finalized concert through
 * both persistence paths (store + live JSONL log), mirroring what the
 * conductor's own `emit` would have done so the transition stays observable.
 */
function buildRecordEvent(orchestron: Orchestron) {
  return async (event: ConcertEvent): Promise<void> => {
    try {
      await orchestron.store.pushEvent(event);
    } catch (err) {
      console.error(`Failed to persist finalize-stale event for '${event.concertId}':`, err);
    }
    try {
      await orchestron.liveEventLog.append(event.concertId, event);
    } catch (err) {
      console.error(`Failed to append finalize-stale event for '${event.concertId}':`, err);
    }
  };
}

export async function finalizeStaleCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  json: boolean,
): Promise<void> {
  const recordEvent = buildRecordEvent(orchestron);

  if (concertId) {
    const result = await finalizeStaleConcert(orchestron.store, concertId, { recordEvent });
    if (!result.finalized) {
      const stored = await orchestron.store.getConcert(concertId);
      const msg = stored
        ? `Concert '${concertId}' is not stale (status: ${stored.status}) — nothing to finalize`
        : `Concert '${concertId}' not found`;
      printOutput(json, { concertId, finalized: false }, () => msg);
      process.exitCode = 1;
      return;
    }
    printOutput(json, result, () => formatFinalizeHuman(result));
    return;
  }

  const results = await finalizeAllStale(orchestron.store, { recordEvent });
  if (results.length === 0) {
    const msg = 'No stale concerts to finalize.';
    printOutput(json, [], () => msg);
    return;
  }
  printOutput(json, results, () => formatFinalizeAllHuman(results));
}

function formatFinalizeHuman(result: FinalizeStaleResult): string {
  const lines: string[] = [];
  lines.push(`Finalized stale concert ${result.concertId}`);
  lines.push(`Status:  failed`);
  lines.push(`Reason:  process_died (${result.reason ?? 'unknown'})`);
  return lines.join('\n');
}

function formatFinalizeAllHuman(results: FinalizeStaleResult[]): string {
  const lines: string[] = ['Finalized stale concerts:'];
  for (const result of results) {
    lines.push(`  ${result.concertId}  failed (process_died: ${result.reason ?? 'unknown'})`);
  }
  return lines.join('\n');
}
