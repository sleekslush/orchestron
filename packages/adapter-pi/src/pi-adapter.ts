import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { HarnessAdapter, HarnessAdapterExecuteOptions, HarnessResponse, HarnessModelInfo } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import { HarnessError, dollarsToMicro, tryParseStructuredFromText, SessionPool } from '@orchestron/core';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Model, Usage, Api } from '@earendil-works/pi-ai';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

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
  modelRuntime: ModelRuntime;
}

export class PiAdapter implements HarnessAdapter {
  readonly type = 'pi';
  private model: Model<Api> | undefined;
  private modelId: string | undefined;
  private provider: string | undefined;
  private tools: string[] | undefined;
  private excludeTools: string[] | undefined;
  private sessionPool: SessionPool<PiSessionData>;
  private modelRuntime: ModelRuntime | undefined;
  /** Working directory per persistent session id (from execute options). */
  private sessionCwds = new Map<string, string>();
  /** Native session persistence dir per persistent session id (from execute options). */
  private sessionDirs = new Map<string, string>();

  constructor(config: PiAdapterConfig = {}) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.tools = config.tools;
    this.excludeTools = config.excludeTools;
    this.sessionPool = new SessionPool(
      (sessionId) =>
        this.createPiSession(
          undefined,
          this.sessionCwds.get(sessionId),
          this.sessionDirs.get(sessionId),
        ),
      (data) => Promise.resolve(data.session.dispose()),
    );
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: HarnessAdapterExecuteOptions,
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
    const thinkingLevel = this.extractThinkingLevel(options?.options?.thinkingLevel);

    await this.resolveModel(provider, modelId);

    let session: AgentSession | undefined;
    let abortListener: (() => void) | undefined;
    let ownSession = false;

    try {
      if (options?.sessionId) {
        if (options.cwd) this.sessionCwds.set(options.sessionId, options.cwd);
        if (options.sessionDir) this.sessionDirs.set(options.sessionId, options.sessionDir);
        const existing = await this.sessionPool.getOrCreate(options.sessionId);
        session = existing.session;
        if (thinkingLevel) {
          session.setThinkingLevel(thinkingLevel);
        }
      } else {
        ownSession = true;
        const fresh = await this.createPiSession(thinkingLevel, options?.cwd);
        session = fresh.session;
      }

      // Per-attempt 1:1 event-stream export: session header line, then
      // `JSON.stringify(event)` per AgentSessionEvent — byte-identical to
      // `pi --mode json` output for the same session/prompt.
      let exportStream: WriteStream | undefined;
      if (options?.exportJsonl) {
        exportStream = createWriteStream(options.exportJsonl, { flags: 'w' });
        exportStream.on('error', (err) => {
          console.error(
            `Failed to write Pi session export '${options.exportJsonl}':`,
            err,
          );
        });
        const header = session.sessionManager.getHeader();
        if (header) {
          exportStream.write(JSON.stringify(header) + '\n');
        }
      }

      let output = '';
      let finalUsage: Usage | undefined;
      let model: string | undefined;
      let provider: string | undefined;
      let cumulativeCost = 0;
      let cumulativeInput = 0;
      let cumulativeOutput = 0;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (exportStream) {
          exportStream.write(JSON.stringify(event) + '\n');
        }
        if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text_delta') {
            output += ame.delta;
            options?.onProgress?.({ type: 'text_delta', delta: ame.delta });
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
        // Await flush so the export is fully on disk before execute() resolves
        // and the conductor stamps the manifest entry.
        if (exportStream) {
          await new Promise<void>((resolve) => exportStream!.end(resolve));
        }
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

      return {
        output,
        structured,
        summary,
        usage,
        model,
        provider,
        // The real Pi session id (matches the export header and session file
        // name) so the manifest records the native session, not the pool key.
        sessionId: session.sessionManager.getSessionId(),
        // Only persisted sessions have a reopenable session file on disk.
        sessionFile: options?.sessionDir
          ? session.sessionManager.getSessionFile()
          : undefined,
      };
    } finally {
      if (ownSession && session) {
        session.dispose();
      }
    }
  }

  async listModels(): Promise<HarnessModelInfo[]> {
    const modelRuntime = await this.ensureModelRuntime();
    return modelRuntime
      .getModels()
      .map((m) => ({ provider: m.provider, model: m.id }));
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.sessionCwds.delete(sessionId);
    this.sessionDirs.delete(sessionId);
    await this.sessionPool.disposeSession(sessionId);
  }

  /** Dispose every tracked session. Useful for graceful shutdown. */
  async dispose(): Promise<void> {
    await this.sessionPool.disposeAll();
  }

  private async ensureModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      // Build the catalog exactly the way pi's interactive runtime does: merge
      // static built-ins with the remote-catalog overlay and read/write the same
      // ~/.pi/agent/models-store.json cache. `allowModelNetwork` lets a fresh
      // environment fetch + cache remote catalogs; on network failure it degrades
      // to the cached/static catalog rather than hard-failing.
      this.modelRuntime = await ModelRuntime.create({ allowModelNetwork: true });
    }
    return this.modelRuntime;
  }

  private async resolveModel(provider?: string, modelId?: string): Promise<void> {
    const targetProvider = provider ?? this.provider;
    const targetModelId = modelId ?? this.modelId;

    // Always re-resolve — different execute() calls may specify different models.
    this.model = undefined;

    if (!targetProvider || !targetModelId) return;

    const modelRuntime = await this.ensureModelRuntime();
    const resolved = modelRuntime.getModel(targetProvider, targetModelId);
    if (!resolved) {
      throw new HarnessError(
        `Unknown Pi model '${targetModelId}' for provider '${targetProvider}'. ` +
        `Use 'pi --list-models' to see available models.`,
        'HARNESS_FAILURE',
      );
    }
    this.model = resolved;
  }

  private extractThinkingLevel(value: unknown): ThinkingLevel | undefined {
    if (value === undefined) return undefined;
    if (!isThinkingLevel(value)) {
      throw new HarnessError(
        `Invalid Pi thinking level '${String(value)}'. Valid values: ${THINKING_LEVELS.join(', ')}.`,
        'HARNESS_FAILURE',
      );
    }
    return value;
  }

  private async createPiSession(
    thinkingLevel?: ThinkingLevel,
    cwd?: string,
    sessionDir?: string,
  ): Promise<PiSessionData> {
    const modelRuntime = await this.ensureModelRuntime();

    const sessionOptions: Parameters<typeof createAgentSession>[0] = {
      model: this.model as never,
      // A persisted session manager writes a real Pi session file (reopenable
      // in the Pi CLI); in-memory keeps the old throwaway behavior for
      // callers that don't pass a session dir.
      sessionManager: sessionDir
        ? SessionManager.create(cwd ?? process.cwd(), sessionDir)
        : SessionManager.inMemory(),
      modelRuntime,
    };

    if (cwd !== undefined) {
      sessionOptions.cwd = cwd;
    }
    if (thinkingLevel !== undefined) {
      sessionOptions.thinkingLevel = thinkingLevel;
    }
    if (this.tools !== undefined) {
      sessionOptions.tools = this.tools;
    }
    if (this.excludeTools !== undefined) {
      sessionOptions.excludeTools = this.excludeTools;
    }

    const { session } = await createAgentSession(sessionOptions);
    return { session, modelRuntime };
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
