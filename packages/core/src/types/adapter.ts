import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';
import type { SessionTraceEvent } from './session-trace.js';

export type ProgressUpdate =
  | { type: 'tool_execution_start'; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result?: unknown; error?: string }
  | { type: 'heartbeat'; elapsedMs: number; message: string }
  | { type: 'usage_update'; usage: ResourceUsage };

export interface HarnessAdapter {
  readonly type: string;
  execute(
    prompt: string,
    context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
      sessionId?: string;
      model?: string;
      provider?: string;
      onProgress?: (update: ProgressUpdate) => void;
    },
  ): Promise<HarnessResponse>;
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
