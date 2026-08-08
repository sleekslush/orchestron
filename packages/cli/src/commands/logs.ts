import { concertLog, type ConcertLogLine } from '@orchestron/core';
import type { Orchestron } from '../orchestron.js';

/** Replay a concert's session recording as a stream of log lines. */
export async function logCommandHandler(
  orchestron: Orchestron,
  concertId: string,
  follow: boolean,
  json: boolean,
): Promise<void> {
  const stream = concertLog(orchestron.concertsDir, concertId, { follow });
  for await (const line of stream) {
    printLine(line, json);
  }
}

function printLine(line: ConcertLogLine, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(line));
    return;
  }
  console.log(formatLineHuman(line));
}

function formatLineHuman(line: ConcertLogLine): string {
  if (line.type === 'orchestron:concert') {
    return `concert ${line.concertId} (${line.scoreId}) — ${line.status}`;
  }
  if (line.type === 'orchestron:movement') {
    return `movement ${line.order} ${line.movementId} (attempt ${line.attempt}) — ${line.status}`;
  }
  return JSON.stringify(line);
}
