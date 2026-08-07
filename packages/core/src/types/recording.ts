/**
 * Concert session recording types.
 *
 * Every movement attempt is recorded as its own 1:1 harness event stream
 * (`exports/<movementId>.<NNN>.jsonl`), the harness's native session is
 * persisted under `sessions/<movementId>/` (Pi) or referenced by id
 * (opencode), and `manifest.json` records the exact playback order of every
 * attempt. Replaying a concert = walking `movements[]` in array order and
 * parsing each `exportFile` with the parser registered for its `format`.
 */

/** Line-schema identifiers for the per-attempt export files. */
export const SESSION_FORMATS = {
  /** Pi: header line (session header) + `JSON.stringify(AgentSessionEvent)` per line.
   *  Byte-identical to `pi --mode json` output for the same session/prompt. */
  PI: 'pi/session-event@1',
  /** opencode: one `V2Event`/`GlobalEvent` JSON object per line (self-identifying via sessionID). */
  OPENCODE: 'opencode/global-event@1',
} as const;

export type SessionFormat = (typeof SESSION_FORMATS)[keyof typeof SESSION_FORMATS];

export const MANIFEST_SCHEMA = 'orchestron/concert-manifest@1';

/** Reference to the harness's native session for one movement attempt. */
export interface ConcertManifestSession {
  /** Session key: Pi uses `concertId:movementId`, opencode uses its sessionID. */
  id: string;
  /**
   * Filesystem location of the native session, relative to the concert dir.
   * Present for harnesses that persist real session files (Pi). Omitted when
   * the session lives inside the harness's own store (opencode).
   */
  dir?: string;
  /** Human/CLI instruction for reopening this session in the harness. */
  reopenHint?: string;
}

/** One movement attempt (one hit). Array order of `movements[]` == playback order. */
export interface ConcertManifestMovement {
  /** 1-based playback order across the whole concert. */
  order: number;
  movementId: string;
  /** 1-based attempt number for this movement (retries bump it). */
  attempt: number;
  status: 'completed' | 'failed' | 'rejected';
  /** Adapter type that ran the attempt (`pi` | `opencode`). */
  harness: string;
  /** Line-schema id for `exportFile` (see SESSION_FORMATS). */
  format: SessionFormat;
  /** Path of the per-attempt event stream, relative to the concert dir. */
  exportFile?: string;
  session: ConcertManifestSession;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface ConcertManifest {
  concertId: string;
  scoreId: string;
  schema: typeof MANIFEST_SCHEMA;
  status: string;
  createdAt: string;
  completedAt?: string;
  movements: ConcertManifestMovement[];
}
