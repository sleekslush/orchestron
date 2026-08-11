import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';

export type ProgressUpdate =
  | { type: 'tool_execution_start'; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result?: unknown; error?: string }
  | { type: 'heartbeat'; elapsedMs: number; message: string }
  | { type: 'usage_update'; usage: ResourceUsage }
  | { type: 'text_delta'; delta: string };

/**
 * Append-only sink for raw SDK events. The adapter calls {@link record} with
 * the event object exactly as the SDK delivered it, as the first statement in
 * its event handler; the enclosing system stamps the envelope (ts, concert,
 * movement, attempt, harness) outside the object while `data` stays verbatim.
 *
 * JSON.stringify is the fidelity boundary: if an object cannot be serialized
 * the recorder logs loudly and continues; recording never throws.
 */
export interface RawEventSink {
  /**
   * Record one raw SDK event verbatim. `meta.type` is used as the envelope
   * type when the event has no string `type` field (e.g. synthetic records).
   * `meta.synthetic` marks records that were not emitted by the SDK.
   * Never throws: serialization failures are logged internally.
   */
  record(event: unknown, meta?: { synthetic?: boolean; type?: string }): void;
  /** Resolve once every recorded event has been written to disk. */
  flush(): Promise<void>;
  /** Number of records recorded so far. */
  readonly count: number;
}

/**
 * Per-attempt recording context handed to an adapter via
 * {@link HarnessAdapterExecuteOptions.recording}. Exists whenever the
 * conductor is writing traces for this attempt.
 */
export interface SessionRecording {
  /** Concert the attempt belongs to. */
  concertId: string;
  /** Movement the attempt belongs to. */
  movementId: string;
  /** Attempt index (0 = first execute call). */
  attemptIndex: number;
  /** Raw SDK event sink bound to this attempt's stream context. */
  events: RawEventSink;
  /** Directory for this attempt's native session artifacts
   *  (`concerts/<concertId>/movements/<movementId>/attempt-<n>/`). */
  attemptDir: string;
  /** Pool key for the session (`<concertId>:<movementId>`), when persistent. */
  sessionKey: string | undefined;
  /** Cumulative (retries share one session) or fresh (each attempt gets its own). */
  mode: 'cumulative' | 'fresh';
  /**
   * Real SDK session id, once known. The adapter sets it as soon as the SDK
   * reveals it (e.g. the opencode session id); it is stamped on later envelope
   * records and written into metadata.json.
   */
  sessionId?: string;
  /**
   * Record a synthetic record: one that was not emitted by the SDK, e.g. the
   * exact user prompt as passed to `session.prompt()`. Flagged `synthetic: true`.
   */
  recordSynthetic(type: string, data: unknown): void;
}

export interface HarnessAdapterExecuteOptions {
  signal?: AbortSignal;
  output?: OutputConfig;
  movementId?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  /** Harness-specific options (e.g. thinking level, variant) passed through
   *  from the score's per-harness model config. Each adapter decides which
   *  keys it honors. */
  options?: Record<string, unknown>;
  onProgress?: (update: ProgressUpdate) => void;
  /** Working directory for the harness session (tool calls land here).
   *  Default: process.cwd(). */
  cwd?: string;
  /**
   * Per-attempt recording context, present when the conductor is writing
   * traces for this attempt. The adapter records raw SDK events through
   * `recording.events` and writes its native session export into
   * `recording.attemptDir` before execute() settles.
   */
  recording?: SessionRecording;
}

export interface HarnessModelInfo {
  provider: string;
  model: string;
}

export interface HarnessAdapter {
  readonly type: string;
  execute(
    prompt: string,
    context: ConcertContext,
    options?: HarnessAdapterExecuteOptions,
  ): Promise<HarnessResponse>;
  /** Return the (provider, model) pairs this adapter can execute with.
   *  Adapters that cannot enumerate models omit this method. */
  listModels?(): Promise<HarnessModelInfo[]>;
  disposeSession?(sessionId: string): Promise<void>;
  /** Optional global cleanup for the adapter (e.g. embedded server shutdown). */
  dispose?(): Promise<void>;
}

export interface HarnessResponse {
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  usage: ResourceUsage;
  model?: string;
  provider?: string;
}

export interface HarnessAdapterResolver {
  resolve(name: string): Promise<HarnessAdapter>;
}
