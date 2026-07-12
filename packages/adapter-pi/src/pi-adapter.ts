import type { HarnessAdapter, HarnessResponse } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import type { OutputConfig } from '@orchestron/core';
import { HarnessError } from '@orchestron/core';
import { createModels } from '@earendil-works/pi-ai';
import type { Context, Model, Api, StreamOptions } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export interface PiAdapterConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
}

export class PiAdapter implements HarnessAdapter {
  readonly type = 'pi';
  private models: ReturnType<typeof createModels>;
  private model: Model<Api>;
  private apiKey?: string;

  constructor(config: PiAdapterConfig = {}) {
    const providerId = config.provider ?? 'openai';
    const modelId = config.model ?? 'gpt-4o-mini';
    this.apiKey = config.apiKey;

    this.models = createModels();
    for (const provider of builtinProviders()) {
      this.models.setProvider(provider);
    }

    const resolved = this.models.getModel(providerId, modelId);
    if (!resolved) {
      throw new HarnessError(
        `Pi model '${providerId}/${modelId}' not found. Available providers: ${this.models.getProviders().map(p => p.id).join(', ')}`,
      );
    }

    this.model = resolved;
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
    },
  ): Promise<HarnessResponse> {
    let finalPrompt = prompt;
    if (options?.output?.mode === 'structured' && options.output.schema) {
      finalPrompt =
        prompt +
        `\n\nYou MUST return your response as a JSON object conforming to this schema:\n` +
        `${JSON.stringify(options.output.schema, null, 2)}`;
    }

    const context: Context = {
      messages: [
        { role: 'user', content: finalPrompt, timestamp: Date.now() },
      ],
    };

    const streamOptions: StreamOptions = {
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    };

    try {
      const response = await this.models.complete(this.model, context, streamOptions);

      let output = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          output += block.text;
        }
      }

      let structured: Record<string, unknown> | undefined;
      if (options?.output?.mode === 'structured') {
        structured = this.tryParseStructured(output);
      }

      const usage = {
        spend: response.usage?.cost?.total
          ? Math.round(response.usage.cost.total * 1_000_000)
          : undefined,
        tokens: response.usage
          ? (response.usage.input ?? 0) + (response.usage.output ?? 0)
          : undefined,
        inputTokens: response.usage?.input,
        outputTokens: response.usage?.output,
      };

      const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;

      return {
        output,
        structured,
        summary,
        usage,
      };
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError') {
        throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
      }
      throw new HarnessError(
        `Pi harness execution failed: ${(err as Error).message ?? String(err)}`,
        'HARNESS_FAILURE',
      );
    }
  }

  private tryParseStructured(
    output: string,
  ): Record<string, unknown> | undefined {
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ?? output.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : output;
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through
    }
    return undefined;
  }
}
