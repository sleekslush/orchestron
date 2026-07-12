import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';

export type ProgressUpdate =
  | { type: 'tool_execution_start'; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result?: unknown; error?: string }
  | { type: 'heartbeat'; elapsedMs: number; message: string };

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
      onProgress?: (update: ProgressUpdate) => void;
    },
  ): Promise<HarnessResponse>;
  disposeSession?(sessionId: string): Promise<void>;
  /** Optional global cleanup for the adapter (e.g. embedded server shutdown). */
  dispose?(): Promise<void>;
}

export interface HarnessResponse {
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  usage: ResourceUsage;
}

export interface HarnessAdapterResolver {
  resolve(name: string): Promise<HarnessAdapter>;
}
