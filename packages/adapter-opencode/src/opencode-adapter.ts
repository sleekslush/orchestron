import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { HarnessAdapter, HarnessAdapterExecuteOptions, HarnessResponse, HarnessModelInfo } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import {
  HarnessError,
  dollarsToMicro,
  tryParseStructured,
  tryParseStructuredFromText,
  SessionPool,
} from '@orchestron/core';
import {
  createOpencode,
  createOpencodeClient,
} from '@opencode-ai/sdk/v2';
import type {
  AssistantMessage,
  Message,
  OpencodeClient,
  Part,
  Session,
  V2Event,
} from '@opencode-ai/sdk/v2';

// --------------------------------------------------------------------------
// Part-filter helpers (extractText)
// --------------------------------------------------------------------------

interface TextPart { type: 'text'; text: string }

function isTextPart(p: unknown): p is TextPart {
  return (
    p != null &&
    typeof p === 'object' &&
    (p as Record<string, unknown>).type === 'text' &&
    typeof (p as Record<string, unknown>).text === 'string'
  );
}

function collectTextParts(parts: unknown[]): string[] {
  return parts.filter(isTextPart).map((p) => p.text);
}

export interface OpencodeAdapterConfig {
  /**
   * Connect to an existing opencode server. If provided, `embedded` is ignored.
   * Default: `http://localhost:4096`
   */
  baseUrl?: string;
  /**
   * Start an embedded opencode server instead of connecting to an existing one.
   */
  embedded?: {
    hostname?: string;
    port?: number;
    config?: Record<string, unknown>;
  };
  /** Optional model provider override (e.g. `anthropic`). */
  provider?: string;
  /** Optional model id override (e.g. `claude-3-5-sonnet-20241022`). */
  modelId?: string;
  /** Optional allowlist of tool names. */
  tools?: string[];
}

interface OpencodeSessionData {
  opencodeSessionId: string;
}

export class OpencodeAdapter implements HarnessAdapter {
  readonly type = 'opencode';
  private client: OpencodeClient | undefined;
  private server: { url: string; close(): void } | undefined;
  private ownsServer = false;
  private provider: string | undefined;
  private modelId: string | undefined;
  private tools: string[] | undefined;
  private sessionPool: SessionPool<OpencodeSessionData>;
  private config: OpencodeAdapterConfig;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  /** Cached model catalog from the server, populated on first successful fetch. */
  private validatedModels: Array<{ providerID: string; modelID: string }> | undefined;
  /** Working directory per session id (from execute options). */
  private sessionCwds = new Map<string, string>();

  constructor(config: OpencodeAdapterConfig = {}) {
    this.config = config;
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.tools = config.tools;
    this.sessionPool = new SessionPool(
      (sessionId) => this.createOpencodeSession(sessionId, this.sessionCwds.get(sessionId)),
      async (data) => {
        await this.client?.session
          .delete({ sessionID: data.opencodeSessionId })
          .catch(() => {});
      },
    );
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: HarnessAdapterExecuteOptions,
  ): Promise<HarnessResponse> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new HarnessError(
        'Opencode client is not initialized',
        'HARNESS_FAILURE',
      );
    }

    // Use model/provider from options (per-movement) if provided, otherwise fall back to config
    const provider = options?.provider ?? this.provider;
    const modelId = options?.model ?? this.modelId;

    // Validate model before creating a session or spending tokens. A
    // down/unreachable server fails fast here with a clear message naming
    // the requested model, rather than surfacing a bare connection error
    // from the prompt call.
    if (provider && modelId) {
      await this.validateModel(provider, modelId);
    }

    let sessionData: OpencodeSessionData | undefined;
    let ownSession = false;
    let abortListener: (() => void) | undefined;
    let exportStream: WriteStream | undefined;
    const eventController = new AbortController();

    try {
      if (options?.sessionId) {
        if (options.cwd) this.sessionCwds.set(options.sessionId, options.cwd);
        sessionData = await this.sessionPool.getOrCreate(options.sessionId);
      } else {
        ownSession = true;
        sessionData = await this.createOpencodeSession('ephemeral', options?.cwd);
      }

      const opencodeSessionId = sessionData.opencodeSessionId;

      // Per-attempt 1:1 event-stream export: one `JSON.stringify(event)` line
      // per GlobalEvent/V2Event observed for this session during the attempt.
      if (options?.exportJsonl) {
        exportStream = createWriteStream(options.exportJsonl, { flags: 'w' });
        exportStream.on('error', (err) => {
          console.error(
            `Failed to write opencode session export '${options.exportJsonl}':`,
            err,
          );
        });
      }

      // Determine the message boundary for this turn so per-turn usage (cost +
      // tokens) can be aggregated across every assistant message in the turn
      // without double-counting prior turns in a persistent (reused) session.
      // A fresh/ephemeral session always starts at index 0.
      let turnStartIndex = 0;
      if (options?.sessionId) {
        try {
          const prior = await this.client.session.messages({
            sessionID: opencodeSessionId,
          });
          turnStartIndex = prior.data?.length ?? 0;
        } catch {
          turnStartIndex = 0;
        }
      }

      const parameters: {
        sessionID: string;
        parts: Array<{ type: 'text'; text: string }>;
        model?: { providerID: string; modelID: string };
        format?: { type: 'json_schema'; schema: Record<string, unknown> };
        tools?: Record<string, boolean>;
        variant?: string;
      } = {
        sessionID: opencodeSessionId,
        parts: [{ type: 'text', text: prompt }],
      };

      if (provider && modelId) {
        parameters.model = { providerID: provider, modelID: modelId };
      }

      if (typeof options?.options?.variant === 'string' && options.options.variant) {
        parameters.variant = options.options.variant;
      }

      if (options?.output?.mode === 'structured' && options.output.schema) {
        parameters.format = {
          type: 'json_schema',
          schema: options.output.schema,
        };
      }

      if (this.tools !== undefined) {
        parameters.tools = Object.fromEntries(
          this.tools.map((name) => [name, true]),
        );
      }

      // Register the abort listener before awaiting promptAsync so an abort can
      // interrupt a prompt that has not yet returned.
      if (options?.signal) {
        abortListener = () => {
          eventController.abort();
          Promise.resolve(
            this.client?.session.abort({ sessionID: opencodeSessionId }),
          ).catch(() => {});
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
      }

      let promptResult: Awaited<ReturnType<OpencodeClient['session']['promptAsync']>> | undefined;
      try {
        promptResult = await this.client.session.promptAsync(parameters);
      } catch (err) {
        if (options?.signal?.aborted) {
          throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
        }
        throw new HarnessError(
          `Opencode harness execution failed: ${(err as Error).message ?? String(err)}`,
          'HARNESS_FAILURE',
        );
      }

      if (options?.signal?.aborted) {
        throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
      }

      if ('error' in promptResult && promptResult.error) {
        throw new HarnessError(
          `Opencode harness execution failed: ${String(promptResult.error)}`,
          'HARNESS_FAILURE',
        );
      }

      let eventStream: { stream: AsyncIterable<V2Event> } | undefined;
      try {
        const subResult = await this.client.event.subscribe(
          {},
          { signal: eventController.signal },
        );
        eventStream = subResult as { stream: AsyncIterable<V2Event> };
      } catch {
        eventStream = undefined;
      }

      if (eventStream) {
        const toolCalls = new Map<string, string>();
        let completed = false;
        let failed = false;
        let failureMessage: string | undefined;

        const consumePromise = (async () => {
          for await (const raw of eventStream.stream) {
            if (eventController.signal.aborted) break;
            const event = raw as V2Event;
            if (!this.isEventForSession(event, opencodeSessionId)) continue;
            if (exportStream) {
              exportStream.write(JSON.stringify(event) + '\n');
            }

            const props = (event as Record<string, unknown>).properties as
              | Record<string, unknown>
              | undefined;
            if (!props) continue;

            switch (event.type) {
              case 'session.next.text.delta': {
                const delta = props.delta as string;
                options?.onProgress?.({ type: 'text_delta', delta });
                break;
              }
              case 'session.next.tool.called': {
                const toolName = props.tool as string;
                const callID = props.callID as string;
                const input = props.input as Record<string, unknown> | undefined;
                toolCalls.set(callID, toolName);
                options?.onProgress?.({
                  type: 'tool_execution_start',
                  toolName,
                  args: input,
                });
                break;
              }
              case 'session.next.tool.success': {
                const callID = props.callID as string;
                const toolName = toolCalls.get(callID) ?? 'unknown';
                const result = props.result ?? props.content;
                options?.onProgress?.({
                  type: 'tool_execution_end',
                  toolName,
                  isError: false,
                  result,
                });
                break;
              }
              case 'session.next.tool.failed': {
                const callID = props.callID as string;
                const toolName = toolCalls.get(callID) ?? 'unknown';
                const error = this.extractOpencodeError(props.error);
                options?.onProgress?.({
                  type: 'tool_execution_end',
                  toolName,
                  isError: true,
                  error,
                });
                break;
              }
              case 'session.next.step.ended':
                completed = true;
                eventController.abort();
                break;
              case 'session.next.step.failed':
                failed = true;
                failureMessage = this.extractOpencodeError(props.error);
                eventController.abort();
                break;
            }

            if (completed || failed) break;
          }
        })();

        await consumePromise;

        if (options?.signal?.aborted) {
          throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
        }
        if (failed) {
          throw new HarnessError(
            `Opencode harness execution failed: ${failureMessage ?? 'Unknown error'}`,
            'HARNESS_FAILURE',
          );
        }

        // Whether or not the subscription observed a terminal step event, return
        // the result via the post-hoc session trace rather than relying on the
        // live stream: if promptAsync resolved after the turn finished, the
        // stream has already ended and an unobserved completion should not be a
        // hard failure.
        return await this.waitForFinalResponse(
          opencodeSessionId,
          options?.signal,
          options?.output?.mode === 'structured',
          turnStartIndex,
        );
      }

      // Subscription failed; fall back to the post-hoc session trace.
      return await this.waitForFinalResponse(
        opencodeSessionId,
        options?.signal,
        options?.output?.mode === 'structured',
        turnStartIndex,
      );
    } finally {
      eventController.abort();
      // Await flush so the export is fully on disk before execute() resolves
      // and the conductor stamps the manifest entry.
      if (exportStream) {
        await new Promise<void>((resolve) => exportStream!.end(resolve));
      }
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      if (ownSession && sessionData) {
        await this.client?.session
          .delete({ sessionID: sessionData.opencodeSessionId })
          .catch(() => {});
      }
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.sessionCwds.delete(sessionId);
    await this.sessionPool.disposeSession(sessionId);
  }

  async dispose(): Promise<void> {
    await this.sessionPool.disposeAll();

    if (this.ownsServer && this.server) {
      this.server.close();
    }
    this.client = undefined;
    this.server = undefined;
    this.initialized = false;
    this.initialization = undefined;
    this.validatedModels = undefined;
  }

  /** Resolves when the adapter has finished initializing its client/server. */
  ready(): Promise<void> {
    return this.ensureInitialized();
  }

  /**
   * Return all (provider, model) pairs the server knows about. Throws a
   * HARNESS_FAILURE when the catalog cannot be fetched.
   */
  async listModels(): Promise<HarnessModelInfo[]> {
    await this.ensureInitialized();
    try {
      await this.fetchModelCatalog();
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      throw new HarnessError(
        `Failed to fetch opencode models: ${(err as Error).message ?? String(err)}`,
        'HARNESS_FAILURE',
      );
    }
    return (this.validatedModels ?? []).map((m) => ({ provider: m.providerID, model: m.modelID }));
  }

  /**
   * Validate that the requested model exists on the Opencode server.
   *
   * Fetches the model catalog on first call and caches it.  When the
   * catalog cannot be fetched (e.g. the server is unreachable) a
   * HARNESS_FAILURE is thrown naming the requested model so the failure
   * surfaces immediately instead of as a bare client connection error.
   */
  private async validateModel(provider: string, modelId: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.fetchModelCatalog();

      if (this.validatedModels) {
        const found = this.validatedModels.some(
          (m) => m.providerID === provider && m.modelID === modelId,
        );
        if (!found) {
          const providerModels = this.validatedModels
            .filter((m) => m.providerID === provider)
            .map((m) => m.modelID);
          throw new HarnessError(
            `Opencode server does not recognize model '${modelId}' for provider '${provider}'.` +
            (providerModels.length > 0
              ? ` Available models for '${provider}': ${providerModels.join(', ')}.`
              : ` Provider '${provider}' is not configured.`),
            'HARNESS_FAILURE',
          );
        }
      }
    } catch (err) {
      if (err instanceof HarnessError) throw err;
      throw new HarnessError(
        `Cannot verify model '${modelId}' for provider '${provider}': ` +
        `opencode server unreachable — ${(err as Error).message ?? String(err)}`,
        'HARNESS_FAILURE',
      );
    }
  }

  /** Fetch and cache the server model catalog (no-op when already cached). */
  private async fetchModelCatalog(): Promise<void> {
    if (!this.client) return;
    if (this.validatedModels) return;

    const result = await this.client.v2.model.list();
    if (result.data?.data) {
      this.validatedModels = result.data.data.map((m) => ({
        providerID: m.providerID,
        modelID: m.id,
      }));
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) {
      try {
        await this.initialization;
      } catch {
        this.initialization = undefined;
        throw new HarnessError(
          'Failed to initialize opencode client',
          'HARNESS_FAILURE',
        );
      }
      return;
    }
    this.initialization = this.initialize(this.config);
    try {
      await this.initialization;
    } catch (err) {
      this.initialization = undefined;
      throw err;
    }
  }

  private async initialize(config: OpencodeAdapterConfig): Promise<void> {
    try {
      if (config.baseUrl) {
        this.client = createOpencodeClient({ baseUrl: config.baseUrl });
      } else if (config.embedded) {
        const serverOptions: { hostname?: string; port?: number; config?: Record<string, unknown> } = {};
        if (config.embedded.hostname !== undefined) {
          serverOptions.hostname = config.embedded.hostname;
        }
        if (config.embedded.port !== undefined) {
          serverOptions.port = config.embedded.port;
        }
        if (config.embedded.config !== undefined) {
          serverOptions.config = config.embedded.config;
        }
        const opencode = await createOpencode(serverOptions);
        this.client = opencode.client;
        this.server = opencode.server;
        this.ownsServer = true;
      } else {
        this.client = createOpencodeClient({
          baseUrl: 'http://localhost:4096',
        });
      }
      this.initialized = true;
    } catch (err) {
      throw new HarnessError(
        `Failed to initialize opencode client: ${(err as Error).message ?? String(err)}`,
        'HARNESS_FAILURE',
      );
    }
  }

  private async createOpencodeSession(
    title: string,
    cwd?: string,
  ): Promise<OpencodeSessionData> {
    if (!this.client) {
      throw new HarnessError(
        'Opencode client is not initialized',
        'HARNESS_FAILURE',
      );
    }

    const result = await this.client.session.create({
      title,
      ...(cwd ? { directory: cwd } : {}),
    });

    if (result.error) {
      throw new HarnessError(
        `Failed to create opencode session: ${String(result.error)}`,
        'HARNESS_FAILURE',
      );
    }

    const session = result.data as Session | undefined;
    if (!session?.id) {
      throw new HarnessError(
        'Opencode session creation returned no session id',
        'HARNESS_FAILURE',
      );
    }

    return { opencodeSessionId: session.id };
  }

  private extractText(parts: Part[] | undefined): string {
    if (!parts) return '';
    return collectTextParts(parts).join('');
  }

  /**
   * Sum usage/cost across every assistant message produced since turnStartIndex
   * (i.e. the current turn) rather than sampling only the final message. A
   * turn that interleaves tool calls yields multiple assistant messages, each
   * carrying its own cost/token usage; those per-step figures must be
   * aggregated to report honest totals. When no assistant message in the turn
   * reports a numeric cost, `spend` is left `undefined` (unmeasured) rather
   * than coerced to zero. If only some messages report a cost (partial
   * measurement), the defined costs are summed and the unmeasured ones
   * contribute nothing — so a partially-measured turn is reported as the sum
   * of its known costs. Token figures are summed whenever any message reports
   * them.
   */
  private aggregateUsage(
    messages: Array<{ info: Message; parts: Part[] }>,
    turnStartIndex: number,
  ): {
    spend?: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  } {
    let spendMicro: number | undefined;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawTokens = false;

    const start = Math.max(0, turnStartIndex);
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i];
      if (!this.isAssistantMessage(msg)) continue;
      const info = msg.info;

      const cost = info.cost;
      if (typeof cost === 'number') {
        spendMicro = (spendMicro ?? 0) + dollarsToMicro(cost);
      }

      const tokens = info.tokens;
      if (tokens) {
        sawTokens = true;
        inputTokens += tokens.input ?? 0;
        outputTokens += tokens.output ?? 0;
        totalTokens += tokens.total ?? ((tokens.input ?? 0) + (tokens.output ?? 0));
      }
    }

    return {
      spend: spendMicro,
      tokens: sawTokens ? totalTokens || undefined : undefined,
      inputTokens: sawTokens ? inputTokens || undefined : undefined,
      outputTokens: sawTokens ? outputTokens || undefined : undefined,
    };
  }

  private isEventForSession(event: V2Event, sessionId: string): boolean {
    const props = (event as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    return props?.sessionID === sessionId;
  }

  private extractOpencodeError(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private isAssistantMessage(
    msg: { info: Message; parts: Part[] },
  ): msg is { info: AssistantMessage; parts: Part[] } {
    return msg.info.role === 'assistant';
  }

  private responseFromMessages(
    messages: Array<{ info: Message; parts: Part[] }>,
    structuredOutput?: boolean,
    turnStartIndex = 0,
  ): HarnessResponse | undefined {
    let last: { info: AssistantMessage; parts: Part[] } | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!this.isAssistantMessage(msg)) continue;
      if (!this.extractText(msg.parts)) continue;
      last = msg;
      break;
    }
    if (!last) return undefined;

    const info = last.info;
    const parts = last.parts;
    const output = this.extractText(parts);

    let structured = tryParseStructured(info.structured);
    if (!structured && structuredOutput) {
      structured = tryParseStructuredFromText(output);
    }

    const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;
    return {
      output,
      structured,
      summary,
      // Aggregate cost/tokens across the whole turn, not just the final message.
      usage: this.aggregateUsage(messages, turnStartIndex),
      model: info.modelID,
      provider: info.providerID,
    };
  }

  private async waitForFinalResponse(
    sessionId: string,
    signal?: AbortSignal,
    structuredOutput = false,
    turnStartIndex = 0,
  ): Promise<HarnessResponse> {
    if (!this.client) {
      throw new HarnessError('Opencode client is not initialized', 'HARNESS_FAILURE');
    }

    // Poll the session trace until a complete assistant message becomes
    // queryable. Bound by the abort signal (driven by the movement timeout)
    // rather than a short fixed cap, so a turn whose final message materializes
    // slowly isn't spuriously failed within a few seconds. A generous constant
    // cap guards against an unbounded loop when no signal is provided.
    const maxAttempts = 3000; // 3000 * 100ms ≈ 5 minutes
    for (let attempt = 0; attempt < maxAttempts && !signal?.aborted; attempt++) {
      const result = await this.client.session.messages({ sessionID: sessionId });
      if (!result.error && result.data) {
        const response = this.responseFromMessages(
          result.data as Array<{ info: Message; parts: Part[] }>,
          structuredOutput,
          turnStartIndex,
        );
        if (response) {
          response.sessionId = sessionId;
          return response;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (signal?.aborted) {
      throw new HarnessError('Execution aborted', 'HARNESS_TIMEOUT');
    }
    throw new HarnessError(
      'Opencode harness did not produce a final response',
      'HARNESS_FAILURE',
    );
  }
}
