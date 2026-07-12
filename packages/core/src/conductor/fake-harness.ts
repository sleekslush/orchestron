import type { HarnessAdapter, HarnessResponse } from '../types/adapter.js';
import type { ConcertContext } from '../types/concert.js';
import type { OutputConfig } from '../types/score.js';
import { HarnessError } from '../types/errors.js';

export interface FakeHarnessScenario {
  output?: string;
  structured?: Record<string, unknown>;
  summary?: string;
  usage?: { spend?: number; tokens?: number; inputTokens?: number; outputTokens?: number };
  fail?: boolean;
  delayMs?: number;
}

export interface FakeHarnessConfig {
  defaultResponse?: FakeHarnessScenario;
  perMovement?: Record<string, FakeHarnessScenario>;
  globalDelayMs?: number;
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly type = 'fake';

  constructor(private config: FakeHarnessConfig) {}

  async execute(
    _prompt: string,
    _context: ConcertContext,
    options?: { signal?: AbortSignal; output?: OutputConfig; movementId?: string },
  ): Promise<HarnessResponse> {
    const movementId = options?.movementId;
    let scenario: FakeHarnessScenario | undefined;

    if (movementId && this.config.perMovement?.[movementId]) {
      scenario = this.config.perMovement[movementId];
    } else {
      scenario = this.config.defaultResponse;
    }

    if (!scenario) {
      return {
        output: 'Default fake output',
        summary: 'Executed successfully',
        usage: { spend: 10, tokens: 100 },
      };
    }

    const delay = scenario.delayMs ?? this.config.globalDelayMs ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (options?.signal?.aborted) {
      throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
    }

    if (scenario.fail) {
      throw new HarnessError(`Fake harness failure for movement '${movementId}'`);
    }

    if (options?.output?.mode === 'structured' && !scenario.structured) {
      scenario.structured = { parsed: true, from: 'fake-harness' };
    }

    return {
      output: scenario.output ?? `Output from ${movementId ?? 'unknown'}`,
      structured: scenario.structured,
      summary: scenario.summary ?? 'Fake harness completed',
      usage: scenario.usage ?? { spend: 10, tokens: 100 },
    };
  }
}
