import type { HarnessAdapter, HarnessResponse } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import type { OutputConfig } from '@orchestron/core';
import { HarnessError } from '@orchestron/core';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Model, Usage, Api } from '@earendil-works/pi-ai';

export interface PiAdapterConfig {
  provider?: string;
  modelId?: string;
}

interface PiSessionData {
  session: AgentSession;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export class PiAdapter implements HarnessAdapter {
  readonly type = 'pi';
  private model: Model<Api> | undefined;
  private modelId: string;
  private provider: string;
  private sessions = new Map<string, PiSessionData>();

  constructor(config: PiAdapterConfig = {}) {
    this.provider = config.provider ?? 'openai';
    this.modelId = config.modelId ?? 'gpt-4o-mini';
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
      sessionId?: string;
    },
  ): Promise<HarnessResponse> {
    let finalPrompt = prompt;
    if (options?.output?.mode === 'structured' && options.output.schema) {
      finalPrompt =
        prompt +
        `\n\nYou MUST return your response as a JSON object conforming to this schema:\n` +
        `${JSON.stringify(options.output.schema, null, 2)}`;
    }

    if (!this.model) {
      this.model = getBuiltinModel(this.provider as never, this.modelId as never) as unknown as Model<Api>;
    }

    let session: AgentSession;
    let unsub: () => void;
    let ownSession = false;

    if (options?.sessionId && this.sessions.has(options.sessionId)) {
      const existing = this.sessions.get(options.sessionId)!;
      session = existing.session;
      unsub = () => {};
    } else {
      ownSession = true;
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const created = await createAgentSession({
        model: this.model as never,
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
        tools: [],
      });
      session = created.session;

      if (options?.sessionId) {
        this.sessions.set(options.sessionId, { session, authStorage, modelRegistry });
      }
      unsub = () => {};
    }

    let output = '';
    let finalUsage: Usage | undefined;

    const subUnsub = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update') {
        const ame = event.assistantMessageEvent;
        if (ame.type === 'text_delta') {
          output += ame.delta;
        }
      }
      if (event.type === 'agent_end') {
        for (const msg of event.messages) {
          if ('usage' in msg && msg.usage) {
            finalUsage = msg.usage as Usage;
          }
        }
      }
    });

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        session.abort().catch(() => {});
      }, { once: true });
    }

    try {
      await session.prompt(finalPrompt);
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
      }
      throw new HarnessError(
        `Pi harness execution failed: ${(err as Error).message ?? String(err)}`,
        'HARNESS_FAILURE',
      );
    } finally {
      subUnsub();
      unsub();
      if (!options?.sessionId) {
        session.dispose();
      }
    }

    let structured: Record<string, unknown> | undefined;
    if (options?.output?.mode === 'structured') {
      structured = this.tryParseStructured(output);
    }

    const usage = {
      spend: finalUsage?.cost?.total
        ? Math.round(finalUsage.cost.total * 1_000_000)
        : undefined,
      tokens: finalUsage
        ? (finalUsage.input ?? 0) + (finalUsage.output ?? 0)
        : undefined,
      inputTokens: finalUsage?.input,
      outputTokens: finalUsage?.output,
    };

    const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;

    return { output, structured, summary, usage };
  }

  async disposeSession(sessionId: string): Promise<void> {
    const data = this.sessions.get(sessionId);
    if (data) {
      data.session.dispose();
      this.sessions.delete(sessionId);
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
