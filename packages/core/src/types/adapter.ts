import type { ConcertContext, ResourceUsage } from './concert.js';
import type { OutputConfig } from './score.js';

export interface HarnessAdapter {
  readonly type: string;
  execute(
    prompt: string,
    context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
    },
  ): Promise<HarnessResponse>;
}

export interface HarnessResponse {
  output: string;
  structured?: Record<string, unknown>;
  summary: string;
  usage: ResourceUsage;
}
