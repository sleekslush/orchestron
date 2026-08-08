import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConcertID } from '../types/concert.js';
import type { ConcertManifestSession } from '../types/recording.js';
import { ConcertRecording } from './concert-recording.js';

/**
 * Streams a concert's recorded history as JSONL-shaped lines, rebuilt from the
 * per-concert recording tree: the manifest supplies concert and movement
 * metadata lines; each movement's export file contributes its literal event
 * lines, parsed but otherwise untouched. `follow` turns the stream live,
 * yielding new lines as the concert writes them and completing once the
 * manifest reaches a terminal status.
 */
export interface ConcertLogConcertLine {
  type: 'orchestron:concert';
  concertId: string;
  scoreId: string;
  schema: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

export interface ConcertLogMovementLine {
  type: 'orchestron:movement';
  order: number;
  movementId: string;
  attempt: number;
  status: string;
  harness?: string;
  format?: string;
  exportFile?: string;
  childConcertId?: string;
  session?: ConcertManifestSession;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** One line of a concert log: a metadata line or a literal parsed export line. */
export type ConcertLogLine = ConcertLogConcertLine | ConcertLogMovementLine | Record<string, unknown>;

export interface ConcertLogOptions {
  /** Keep streaming new lines until the concert reaches a terminal status. */
  follow?: boolean;
  /** Abort a follow stream; a subsequent read starts fresh. */
  signal?: AbortSignal;
  /** Poll interval for follow mode (defaults to 500ms). */
  pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 500;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export async function* concertLog(
  concertsDir: string,
  concertId: ConcertID,
  options: ConcertLogOptions = {},
): AsyncGenerator<ConcertLogLine> {
  const recording = new ConcertRecording(concertsDir);
  const manifestPath = join(recording.concertDir(concertId), 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No recording for concert '${concertId}' at '${manifestPath}'`);
  }

  const exportOffsets = new Map<string, number>();
  let seenMovements = 0;
  let seenStatus: string | undefined;

  while (true) {
    const manifest = await recording.get(concertId);
    if (!manifest) {
      throw new Error(`Unreadable manifest for concert '${concertId}' at '${manifestPath}'`);
    }

    const firstRead = seenStatus === undefined;
    if (firstRead) {
      yield concertLine(manifest);
      seenStatus = manifest.status;
    }

    const terminal = TERMINAL_STATUSES.has(manifest.status);

    for (let i = 0; i < manifest.movements.length; i++) {
      const entry = manifest.movements[i];
      if (i >= seenMovements) {
        yield movementLine(entry);
      }
      if (!entry.exportFile) continue;
      const exportPath = join(recording.concertDir(concertId), entry.exportFile);
      const offset = exportOffsets.get(exportPath) ?? 0;
      const next = await readExportEvents(
        exportPath,
        entry.exportFile,
        offset,
        options.follow === true && !terminal,
      );
      exportOffsets.set(exportPath, next.offset);
      for (const event of next.events) {
        yield event;
      }
    }
    seenMovements = manifest.movements.length;

    if (!options.follow || (firstRead && terminal)) return;
    if (terminal) {
      yield concertLine(manifest);
      return;
    }
    if (options.signal?.aborted) return;
    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS);
    if (options.signal?.aborted) return;
  }
}

function concertLine(manifest: {
  concertId: string;
  scoreId: string;
  schema: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}): ConcertLogConcertLine {
  return {
    type: 'orchestron:concert',
    concertId: manifest.concertId,
    scoreId: manifest.scoreId,
    schema: manifest.schema,
    status: manifest.status,
    createdAt: manifest.createdAt,
    ...(manifest.completedAt ? { completedAt: manifest.completedAt } : {}),
  };
}

function movementLine(entry: {
  order: number;
  movementId: string;
  attempt: number;
  status: string;
  harness?: string;
  format?: string;
  exportFile?: string;
  childConcertId?: string;
  session?: ConcertManifestSession;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}): ConcertLogMovementLine {
  return {
    type: 'orchestron:movement',
    order: entry.order,
    movementId: entry.movementId,
    attempt: entry.attempt,
    status: entry.status,
    ...(entry.harness !== undefined ? { harness: entry.harness } : {}),
    ...(entry.format !== undefined ? { format: entry.format } : {}),
    ...(entry.exportFile !== undefined ? { exportFile: entry.exportFile } : {}),
    ...(entry.childConcertId !== undefined ? { childConcertId: entry.childConcertId } : {}),
    ...(entry.session !== undefined ? { session: entry.session } : {}),
    ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
    ...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
  };
}

/**
 * Read the not-yet-consumed lines of an export file. The final line is
 * treated as a torn crash artifact (no trailing newline) when it does not
 * parse: skipped once the concert is terminal, deferred and retried while
 * the concert is still live (the write may be in flight). An unparseable
 * line anywhere else — including a newline-terminated final line — is
 * corruption and an error.
 */
async function readExportEvents(
  exportPath: string,
  relativePath: string,
  offset: number,
  deferTrailing: boolean,
): Promise<{ events: Array<Record<string, unknown>>; offset: number }> {
  if (!existsSync(exportPath)) {
    if (deferTrailing) return { events: [], offset };
    throw new Error(`Missing export file for movement: '${relativePath}'`);
  }
  const content = await readFile(exportPath, 'utf-8');
  const lines = content.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  const effective = endsWithNewline ? lines.slice(0, -1) : lines;
  const remaining = offset < effective.length ? effective.slice(offset) : [];
  if (remaining.length === 0) return { events: [], offset };

  const events: Array<Record<string, unknown>> = [];
  let consumed = 0;
  for (let i = 0; i < remaining.length; i++) {
    const line = remaining[i];
    if (line === '') {
      consumed = i + 1;
      continue;
    }
    try {
      events.push(parseLine(exportPath, offset + i + 1, line));
    } catch (err) {
      if (i === remaining.length - 1 && !endsWithNewline) {
        consumed = deferTrailing ? consumed : i + 1;
        break;
      }
      throw err;
    }
    consumed = i + 1;
  }
  return { events, offset: offset + consumed };
}

function parseLine(exportPath: string, lineNumber: number, line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(
      `Unparseable export line ${lineNumber} in '${exportPath}': ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Export line ${lineNumber} in '${exportPath}' is not a JSON object: ${line.slice(0, 100)}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
