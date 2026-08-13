import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConcertID, MovementID } from '../types/concert.js';

/**
 * On-disk recording layout for one concert:
 *
 *   concerts/<concertId>/
 *     stream.jsonl                 unified realtime stream (envelopes)
 *     index.json                   concert-level index
 *     movements/<movementId>/
 *       index.json                 movement-level index (attempts + final)
 *       final-pi-session.jsonl     cumulative-mode final snapshot (pi)
 *       final-opencode-session.json  cumulative-mode final snapshot (opencode)
 *       attempt-<n>/
 *         pi-session.jsonl         native pi export (reopenable via `pi --session`)
 *         opencode-session.json    native opencode import artifact
 *         metadata.json            attempt metadata (sessionKey + sessionId + files)
 *
 * Attempts are 0-indexed (`attempt-0` = first execute call, retries follow).
 * `final-*` files exist only for cumulative (persistSession) movements: a
 * fresh movement is N independent sessions enumerated by its index.json.
 */

/** Native (reopenable) session artifact file name per harness. */
export const NATIVE_SESSION_FILE: Record<string, string> = {
  pi: 'pi-session.jsonl',
  opencode: 'opencode-session.json',
};

export const FINAL_SESSION_FILE: Record<string, string> = {
  pi: 'final-pi-session.jsonl',
  opencode: 'final-opencode-session.json',
};

export function movementDirName(movementId: MovementID): string {
  return join('movements', movementId);
}

export function attemptDirName(attemptIndex: number): string {
  return `attempt-${attemptIndex}`;
}

/** Absolute path of the movement directory for a concert. */
export function movementDirPath(
  tracesDir: string,
  concertId: ConcertID,
  movementId: MovementID,
): string {
  return join(tracesDir, concertId, movementDirName(movementId));
}

/** Absolute path of one attempt's directory for a concert+movement. */
export function attemptDirPath(
  tracesDir: string,
  concertId: ConcertID,
  movementId: MovementID,
  attemptIndex: number,
): string {
  return join(movementDirPath(tracesDir, concertId, movementId), attemptDirName(attemptIndex));
}

export interface AttemptMetadata {
  concertId: ConcertID;
  movementId: MovementID;
  attempt: number;
  harness: string;
  mode: 'cumulative' | 'fresh';
  sessionKey: string | undefined;
  sessionId: string | undefined;
  startedAt: string;
  endedAt: string;
  status: 'completed' | 'failed' | 'rejected';
  eventCount: number;
  files: { native?: string; sizeBytes?: number };
}

/** Write the attempt's metadata.json (adapter side; adapter knows sessionId/files). */
export async function writeAttemptMetadata(
  attemptDir: string,
  meta: AttemptMetadata,
): Promise<void> {
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n');
}

export interface AttemptSummary {
  attempt: number;
  status: 'completed' | 'failed' | 'rejected';
  sessionKey: string | undefined;
  path: string;
}

export interface MovementIndex {
  concertId: ConcertID;
  movementId: MovementID;
  movementName: string;
  harness: string | undefined;
  mode: 'cumulative' | 'fresh';
  finalAttempt: number | undefined;
  finalStatus: string | undefined;
  /** Path relative to the movement dir; the final-* copy when cumulative. */
  finalSessionFile: string | undefined;
  attempts: AttemptSummary[];
}

export async function writeMovementIndex(
  movementDir: string,
  index: MovementIndex,
): Promise<void> {
  await mkdir(movementDir, { recursive: true });
  await writeFile(join(movementDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}

export interface ConcertIndexMovement {
  id: MovementID;
  name: string;
  harness: string | undefined;
  mode: 'cumulative' | 'fresh';
  attempts: number;
  finalStatus: string | undefined;
  /** Path relative to the concert dir (movements/.../...). */
  finalSessionFile: string | undefined;
}

export interface ConcertIndex {
  concertId: ConcertID;
  scoreId: string;
  status: string;
  startedAt: string;
  completedAt: string | undefined;
  stream: string;
  movements: ConcertIndexMovement[];
}

export async function writeConcertIndex(
  tracesDir: string,
  concertId: ConcertID,
  index: ConcertIndex,
): Promise<void> {
  const dir = join(tracesDir, concertId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}

/**
 * Copy the final attempt's native session snapshot to the movement-level
 * `final-<harness>-session.<ext>` file (cumulative movements only). If the
 * exact final attempt dir is missing (crash after the last export), falls back
 * to the highest-numbered attempt dir that exists.
 */
export async function copyFinalSession(
  movementDir: string,
  harness: string,
  attemptCount: number,
): Promise<string | undefined> {
  const native = NATIVE_SESSION_FILE[harness];
  const final = FINAL_SESSION_FILE[harness];
  if (!native || !final) return undefined;

  let source = join(movementDir, attemptDirName(attemptCount - 1), native);
  if (!(await fileExists(source))) {
    const existing = await highestAttemptWithNative(movementDir, native);
    if (existing === undefined) return undefined;
    source = join(movementDir, attemptDirName(existing), native);
  }

  await copyFile(source, join(movementDir, final));
  return final;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Largest attempt index whose dir contains the native file, or undefined. */
async function highestAttemptWithNative(
  movementDir: string,
  native: string,
): Promise<number | undefined> {
  const { readdir } = await import('node:fs/promises');
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = (await readdir(movementDir, { withFileTypes: true })) as Array<{
      isDirectory(): boolean;
      name: string;
    }>;
  } catch {
    return undefined;
  }
  const indices = entries
    .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
    .map((e) => Number(e.name.slice('attempt-'.length)))
    .sort((a, b) => b - a);
  for (const i of indices) {
    if (await fileExists(join(movementDir, attemptDirName(i), native))) {
      return i;
    }
  }
  return undefined;
}

/** Read the `id` from a pi session export's header line (SessionHeader). */
export async function readPiSessionId(filePath: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  const firstLine = content.split('\n', 1)[0];
  if (!firstLine) return undefined;
  try {
    const header = JSON.parse(firstLine) as { id?: unknown };
    return typeof header.id === 'string' ? header.id : undefined;
  } catch {
    return undefined;
  }
}

/** Read a movement's index.json, if it exists and parses. */
export async function readMovementIndex(
  movementDir: string,
): Promise<MovementIndex | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const content = await readFile(join(movementDir, 'index.json'), 'utf-8');
    const parsed = JSON.parse(content) as MovementIndex;
    if (
      parsed &&
      typeof parsed.movementId === 'string' &&
      Array.isArray(parsed.attempts)
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read an attempt's metadata.json, if it exists and parses. */
export async function readAttemptMetadata(
  attemptDir: string,
): Promise<AttemptMetadata | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    const content = await readFile(join(attemptDir, 'metadata.json'), 'utf-8');
    const parsed = JSON.parse(content) as AttemptMetadata;
    if (parsed && typeof parsed.movementId === 'string' && typeof parsed.attempt === 'number') {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}