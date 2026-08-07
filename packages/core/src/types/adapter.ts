import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';

export type ProgressUpdate =
  | { type: 'tool_execution_start'; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result?: unknown; error?: string }
  | { type: 'heartbeat'; elapsedMs: number; message: string }
  | { type: 'usage_update'; usage: ResourceUsage }
  | { type: 'text_delta'; delta: string };

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
   * Where the harness should persist its native session (Pi: real session
   * files via `SessionManager.create`). Omitted when the session lives inside
   * the harness's own store (opencode). Adapters that don't support persisted
   * sessions ignore this.
   */
  sessionDir?: string;
  /**
   * Absolute path for this attempt's 1:1 event stream export. Adapters that
   * support recording write one JSON object per line, identical to what the
   * harness CLI emits in JSON mode. Adapters that don't support recording
   * ignore this.
   */
  exportJsonl?: string;
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
  /** The harness's native session identifier for this execution, when one exists
   *  (e.g. the opencode sessionID). Lets the conductor record the real session
   *  in the concert manifest rather than a synthesized key. */
  sessionId?: string;
}

export interface HarnessAdapterResolver {
  resolve(name: string): Promise<HarnessAdapter>;
}
