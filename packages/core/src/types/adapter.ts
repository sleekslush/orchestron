import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';
import type { SessionTraceEvent } from './session-trace.js';

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
   * Optional per-movement skills (names) to load into the session at creation
   * time, in addition to any skills the harness auto-loads. Names resolve
   * against `skillsDir`. An unresolvable name must fail loudly.
   */
  skills?: string[];
  /** Directory to resolve `skills` names from. Default: `<cwd>/skills`. */
  skillsDir?: string;
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
  /** Return session trace events for the given session since the given offset.
   *  No offset → return all events. Offset 0 → all events. Called after execute()
   *  — even if execute() threw. Returns [] when tracing is not supported. */
  getSessionTraceEvents?(sessionId: string, offset?: number): Promise<SessionTraceEvent[]>;
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
