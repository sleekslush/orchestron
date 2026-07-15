import type { HarnessAdapter, HarnessResponse } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import type { OutputConfig } from '@orchestron/core';
import type { SessionTraceEvent } from '@orchestron/core';
import { HarnessError, dollarsToMicro, tryParseStructuredFromText, SessionPool } from '@orchestron/core';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Model, Usage, Api } from '@earendil-works/pi-ai';

export interface PiAdapterConfig {
  /** Built-in provider id (e.g. `openai`, `anthropic`). If omitted, Pi selects from settings. */
  provider?: string;
  /** Built-in model id. Required only when `provider` is also provided. */
  modelId?: string;
  /** Optional allowlist of tool names. Omit to enable Pi defaults (read, bash, edit, write). */
  tools?: string[];
  /** Optional denylist of tool names. */
  excludeTools?: string[];
}

interface PiSessionData {
  session: AgentSession;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export class PiAdapter implements HarnessAdapter {
  readonly type = 'pi';
  private model: Model<Api> | undefined;
  private modelId: string | undefined;
  private provider: string | undefined;
  private tools: string[] | undefined;
  private excludeTools: string[] | undefined;
  private sessionPool: SessionPool<PiSessionData>;
  private authStorage: AuthStorage | undefined;
  private modelRegistry: ModelRegistry | undefined;

  constructor(config: PiAdapterConfig = {}) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.tools = config.tools;
    this.excludeTools = config.excludeTools;
    this.sessionPool = new SessionPool(
      () => this.createPiSession(),
      (data) => Promise.resolve(data.session.dispose()),
    );
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
      sessionId?: string;
      model?: string;
      provider?: string;
      onProgress?: (update: import('@orchestron/core').ProgressUpdate) => void;
    },
  ): Promise<HarnessResponse> {
    let finalPrompt = prompt;
    if (options?.output?.mode === 'structured' && options.output.schema) {
      finalPrompt =
        prompt +
        `\n\nYou MUST return your response as a JSON object conforming to this schema:\n` +
        `${JSON.stringify(options.output.schema, null, 2)}\n` +
        `Return only the JSON object, optionally wrapped in a markdown code block.`;
    }

    // Use model/provider from options (per-movement) if provided, otherwise fall back to config
    const modelId = options?.model ?? this.modelId;
    const provider = options?.provider ?? this.provider;

    this.resolveModel(provider, modelId);

    let session: AgentSession | undefined;
    let abortListener: (() => void) | undefined;
    let ownSession = false;

    try {
      if (options?.sessionId) {
        const existing = await this.sessionPool.getOrCreate(options.sessionId);
        session = existing.session;
      } else {
        ownSession = true;
        const fresh = await this.createPiSession();
        session = fresh.session;
      }

      let output = '';
      let finalUsage: Usage | undefined;
      let model: string | undefined;
      let provider: string | undefined;
      let cumulativeCost = 0;
      let cumulativeInput = 0;
      let cumulativeOutput = 0;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text_delta') {
            output += ame.delta;
          }
        }
        if (event.type === 'tool_execution_start') {
          options?.onProgress?.({
            type: 'tool_execution_start',
            toolName: event.toolName,
            args: this.summarizeToolArgs(event.args as Record<string, unknown> | undefined),
          });
        }
        if (event.type === 'tool_execution_end') {
          const rawResult = event.result as Record<string, unknown> | undefined;
          const isError = event.isError as boolean;
          options?.onProgress?.({
            type: 'tool_execution_end',
            toolName: event.toolName,
            isError,
            result: isError ? undefined : this.summarizeToolResult(rawResult),
            error: isError ? this.extractToolError(rawResult) : undefined,
          });
        }
        if (event.type === 'turn_end') {
          const msg = event.message;
          if ('usage' in msg && msg.usage) {
            const u = msg.usage as Usage;
            cumulativeCost += u.cost?.total ?? 0;
            cumulativeInput += u.input ?? 0;
            cumulativeOutput += u.output ?? 0;
            const hasUsage = cumulativeCost > 0 || cumulativeInput > 0;
            options?.onProgress?.({
              type: 'usage_update',
              usage: {
                spend: cumulativeCost
                  ? dollarsToMicro(cumulativeCost)
                  : undefined,
                tokens: cumulativeInput + cumulativeOutput,
                inputTokens: cumulativeInput,
                outputTokens: cumulativeOutput,
              },
            });
          }
        }

        if (event.type === 'agent_end') {
          for (const msg of event.messages) {
            if ('usage' in msg && msg.usage) {
              finalUsage = msg.usage as Usage;
            }
            if ('model' in msg && typeof msg.model === 'string') {
              const am = msg as AssistantMessage;
              model = am.model;
              provider = am.provider;
            }
          }
        }
      });

      if (options?.signal) {
        abortListener = () => {
          Promise.resolve(session?.abort()).catch(() => {});
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
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
        unsubscribe();
        if (abortListener && options?.signal) {
          options.signal.removeEventListener('abort', abortListener);
        }
      }

      // Fallback to the session's last assistant message if no text deltas were captured.
      if (!output.trim()) {
        const lastText = session.getLastAssistantText?.();
        if (lastText) {
          output = lastText;
        }
      }

      let structured: Record<string, unknown> | undefined;
      if (options?.output?.mode === 'structured') {
        structured = tryParseStructuredFromText(output);
      }

      const hasCumulative = cumulativeInput > 0 || cumulativeOutput > 0;
      const usage = hasCumulative
        ? {
            spend: cumulativeCost
              ? dollarsToMicro(cumulativeCost)
              : undefined,
            tokens: cumulativeInput + cumulativeOutput,
            inputTokens: cumulativeInput,
            outputTokens: cumulativeOutput,
          }
        : this.toResourceUsage(finalUsage);
      const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;

      return { output, structured, summary, usage, model, provider };
    } finally {
      if (ownSession && session) {
        session.dispose();
      }
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.sessionPool.disposeSession(sessionId);
  }

  getSessionTraceEvents(sessionId: string, _offset?: number): Promise<SessionTraceEvent[]> {
    const data = this.sessionPool.get(sessionId);
    if (!data) return Promise.resolve([]);

    const messages = data.session.messages;
    const events: SessionTraceEvent[] = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const ts = new Date(
        'timestamp' in msg && typeof (msg as { timestamp?: number }).timestamp === 'number'
          ? (msg as { timestamp: number }).timestamp
          : Date.now(),
      ).toISOString();

      switch (msg.role) {
        case 'user': {
          const raw = 'content' in msg ? (msg as { content: unknown }).content : undefined;
          const content = typeof raw === 'string' ? raw : (raw !== undefined ? JSON.stringify(raw) : '');
          events.push({ type: 'prompt', content, timestamp: ts });
          break;
        }
        case 'assistant': {
          const maybeContent = 'content' in msg ? (msg as { content: unknown }).content : undefined;
          if (!Array.isArray(maybeContent)) {
            break;
          }
          const blocks = maybeContent as Array<Record<string, unknown>>;
          for (const block of blocks) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
              events.push({ type: 'text_delta', delta: block.text, timestamp: ts });
            } else if (block.type === 'toolCall') {
              events.push({
                type: 'tool_execution_start',
                toolName: typeof block.name === 'string' ? block.name : 'unknown',
                args: typeof block.arguments === 'object' ? (block.arguments as Record<string, unknown>) : undefined,
                timestamp: ts,
              });
            }
          }
          break;
        }
        case 'toolResult': {
          if (
            !('toolName' in msg) ||
            !('isError' in msg) ||
            !('content' in msg)
          ) {
            break;
          }
          events.push({
            type: 'tool_execution_end',
            toolName: String((msg as { toolName: unknown }).toolName),
            isError: Boolean((msg as { isError: unknown }).isError),
            result: (msg as { content: unknown }).content,
            error: 'error' in msg ? String((msg as { error: unknown }).error) : undefined,
            timestamp: ts,
          });
          break;
        }
      }
    }

    return Promise.resolve(events);
  }

  /** Dispose every tracked session. Useful for graceful shutdown. */
  async dispose(): Promise<void> {
    await this.sessionPool.disposeAll();
  }

  private ensureRegistry(): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
    if (!this.authStorage || !this.modelRegistry) {
      this.authStorage = AuthStorage.create();
      this.modelRegistry = ModelRegistry.create(this.authStorage);
    }
    return { authStorage: this.authStorage, modelRegistry: this.modelRegistry };
  }

  private resolveModel(provider?: string, modelId?: string): void {
    const targetProvider = provider ?? this.provider;
    const targetModelId = modelId ?? this.modelId;

    // Always re-resolve — different execute() calls may specify different models.
    this.model = undefined;

    if (!targetProvider || !targetModelId) return;

    const { modelRegistry } = this.ensureRegistry();
    const resolved = modelRegistry.find(targetProvider, targetModelId);
    if (!resolved) {
      throw new HarnessError(
        `Unknown Pi model '${targetModelId}' for provider '${targetProvider}'. ` +
        `Use 'pi --list-models' to see available models.`,
        'HARNESS_FAILURE',
      );
    }
    this.model = resolved;
  }

  private async createPiSession(): Promise<PiSessionData> {
    const { authStorage, modelRegistry } = this.ensureRegistry();

    const sessionOptions: Parameters<typeof createAgentSession>[0] = {
      model: this.model as never,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
    };

    if (this.tools !== undefined) {
      sessionOptions.tools = this.tools;
    }
    if (this.excludeTools !== undefined) {
      sessionOptions.excludeTools = this.excludeTools;
    }

    const { session } = await createAgentSession(sessionOptions);
    return { session, authStorage, modelRegistry };
  }

  private toResourceUsage(finalUsage: Usage | undefined) {
    return {
      spend: finalUsage?.cost?.total
        ? dollarsToMicro(finalUsage.cost.total)
        : undefined,
      tokens: finalUsage
        ? (finalUsage.input ?? 0) + (finalUsage.output ?? 0)
        : undefined,
      inputTokens: finalUsage?.input,
      outputTokens: finalUsage?.output,
    };
  }

  private summarizeToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!args) return undefined;
    const { command, filePath, file, path, content, text, oldString, newString, ...rest } = args;
    const summary: Record<string, unknown> = {};
    if (command !== undefined) summary.command = command;
    if (filePath !== undefined) summary.filePath = filePath;
    if (file !== undefined) summary.file = file;
    if (path !== undefined) summary.path = path;
    // Keep other small metadata; omit large content blobs.
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === 'string' && value.length > 200) continue;
      summary[key] = value;
    }
    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  private summarizeToolResult(result: Record<string, unknown> | undefined): unknown {
    if (!result) return undefined;
    if (typeof result.output === 'string') {
      return result.output.length > 1000 ? result.output.slice(0, 1000) + '...' : result.output;
    }
    if (typeof result.content === 'string') {
      return result.content.length > 1000 ? result.content.slice(0, 1000) + '...' : result.content;
    }
    if (Array.isArray(result.results) && result.results.length > 0) {
      return result.results.slice(0, 5);
    }
    return result;
  }

  private extractToolError(result: Record<string, unknown> | undefined): string | undefined {
    if (!result) return undefined;
    if (typeof result.error === 'string') return result.error;
    if (result.error && typeof result.error === 'object' && typeof (result.error as Record<string, unknown>).message === 'string') {
      return (result.error as Record<string, unknown>).message as string;
    }
    return JSON.stringify(result.error ?? result);
  }
}
