import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative as relativePath } from 'node:path';
import type { ConcertID } from '../types/concert.js';
import {
  ConcertManifest,
  ConcertManifestMovement,
  MANIFEST_SCHEMA,
} from '../types/recording.js';

/**
 * Writes and reads the per-concert recording tree:
 *
 *   <concertsDir>/<concertId>/
 *     manifest.json                 # ordered playback contract
 *     sessions/<movementId>/        # native harness session files
 *     exports/<movementId>.<NNN>.jsonl   # per-attempt 1:1 event streams
 *
 * The manifest is the authoritative replay contract: `movements[]` in array
 * order is the exact order the concert ran, with one entry per movement
 * attempt. Writes are atomic (tmp file + rename) so a crash never leaves a
 * half-written manifest.
 */
export class ConcertRecording {
  constructor(private readonly concertsDir: string) {}

  /** Directory for a concert's recording tree. */
  concertDir(concertId: ConcertID): string {
    return join(this.concertsDir, concertId);
  }

  /** Absolute path for a movement's native session directory. */
  sessionDir(concertId: ConcertID, movementId: string): string {
    return join(this.concertDir(concertId), 'sessions', movementId);
  }

  /** Absolute path for a movement attempt's event-stream export file. */
  exportFile(concertId: ConcertID, movementId: string, attempt: number): string {
    const padded = String(attempt).padStart(3, '0');
    return join(this.concertDir(concertId), 'exports', `${movementId}.${padded}.jsonl`);
  }

  /** Path of an absolute file/dir relative to the concert dir (for manifest entries). */
  relative(concertId: ConcertID, absPath: string): string {
    return relativePath(this.concertDir(concertId), absPath);
  }

  /** Create the concert recording tree and seed an empty manifest.
   *  Idempotent: an existing manifest (e.g. from a recovered concert) is kept. */
  async init(concertId: ConcertID, scoreId: string): Promise<void> {
    if (await this.get(concertId)) return;
    const dir = this.concertDir(concertId);
    await mkdir(join(dir, 'exports'), { recursive: true });
    const manifest: ConcertManifest = {
      concertId,
      scoreId,
      schema: MANIFEST_SCHEMA,
      status: 'running',
      createdAt: new Date().toISOString(),
      movements: [],
    };
    await this.writeManifest(concertId, manifest);
  }

  /** Append one movement-attempt entry (in playback order) and persist. */
  async registerMovement(
    concertId: ConcertID,
    entry: ConcertManifestMovement,
  ): Promise<void> {
    const manifest = await this.get(concertId);
    if (!manifest) return;
    manifest.movements.push(entry);
    await this.writeManifest(concertId, manifest);
  }

  /** Stamp the final concert status on the manifest. */
  async finalize(concertId: ConcertID, status: string): Promise<void> {
    const manifest = await this.get(concertId);
    if (!manifest) return;
    manifest.status = status;
    manifest.completedAt = new Date().toISOString();
    await this.writeManifest(concertId, manifest);
  }

  /** Read the concert manifest, or null when none exists. */
  async get(concertId: ConcertID): Promise<ConcertManifest | null> {
    const filePath = join(this.concertDir(concertId), 'manifest.json');
    if (!existsSync(filePath)) return null;
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as ConcertManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(concertId: ConcertID, manifest: ConcertManifest): Promise<void> {
    const dir = this.concertDir(concertId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, 'manifest.json.tmp');
    const filePath = join(dir, 'manifest.json');
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    await rename(tmp, filePath);
  }
}
