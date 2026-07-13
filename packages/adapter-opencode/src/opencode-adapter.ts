import type { HarnessAdapter, HarnessResponse } from '@orchestron/core';
import type { ConcertContext } from '@orchestron/core';
import type { OutputConfig } from '@orchestron/core';
import type { SessionTraceEvent } from '@orchestron/core';
import { HarnessError } from '@orchestron/core';
import {
  createOpencode,
  createOpencodeClient,
} from '@opencode-ai/sdk/v2';
import type {
  AssistantMessage,
  OpencodeClient,
  Part,
  Session,
} from '@opencode-ai/sdk/v2';

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
  private sessions = new Map<string, OpencodeSessionData>();
  private sessionLocks = new Map<string, Promise<OpencodeSessionData>>();
  private config: OpencodeAdapterConfig;
  private initialized = false;
  private initialization: Promise<void> | undefined;

  constructor(config: OpencodeAdapterConfig = {}) {
    this.config = config;
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.tools = config.tools;
  }

  async execute(
    prompt: string,
    _context: ConcertContext,
    options?: {
      signal?: AbortSignal;
      output?: OutputConfig;
      movementId?: string;
      sessionId?: string;
      onProgress?: (update: import('@orchestron/core').ProgressUpdate) => void;
    },
  ): Promise<HarnessResponse> {
    await this.ensureInitialized();

    if (!this.client) {
      throw new HarnessError(
        'Opencode client is not initialized',
        'HARNESS_FAILURE',
      );
    }

    let sessionData: OpencodeSessionData | undefined;
    let ownSession = false;
    let abortListener: (() => void) | undefined;

    try {
      if (options?.sessionId) {
        sessionData = await this.getOrCreateSession(options.sessionId);
      } else {
        ownSession = true;
        sessionData = await this.createOpencodeSession('ephemeral');
      }

      const opencodeSessionId = sessionData.opencodeSessionId;

      if (options?.signal) {
        abortListener = () => {
          Promise.resolve(
            this.client?.session.abort({ sessionID: opencodeSessionId }),
          ).catch(() => {});
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
      }

      const parameters: {
        sessionID: string;
        parts: Array<{ type: 'text'; text: string }>;
        model?: { providerID: string; modelID: string };
        format?: { type: 'json_schema'; schema: Record<string, unknown> };
        tools?: Record<string, boolean>;
      } = {
        sessionID: opencodeSessionId,
        parts: [{ type: 'text', text: prompt }],
      };

      if (this.provider && this.modelId) {
        parameters.model = { providerID: this.provider, modelID: this.modelId };
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

      let result: { data?: { info?: AssistantMessage; parts?: Part[] }; error?: unknown };
      try {
        result = await this.client.session.prompt(parameters);
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

      if (result.error) {
        throw new HarnessError(
          `Opencode harness execution failed: ${String(result.error)}`,
          'HARNESS_FAILURE',
        );
      }

      const data = result.data;
      if (!data?.info) {
        throw new HarnessError(
          'Opencode harness returned empty response',
          'HARNESS_FAILURE',
        );
      }

      const output = this.extractText(data.parts);
      const structured = this.tryParseStructured(data.info.structured);
      const usage = this.toResourceUsage(data.info);
      const summary = output.length > 200 ? output.slice(0, 200) + '...' : output;

      return { output, structured, summary, usage };
    } finally {
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
    const data = this.sessions.get(sessionId);
    if (!data) return;

    await this.client?.session
      .delete({ sessionID: data.opencodeSessionId })
      .catch(() => {});
    this.sessions.delete(sessionId);
  }

  async getSessionTraceEvents(sessionId: string, _offset?: number): Promise<SessionTraceEvent[]> {
    const data = this.sessions.get(sessionId);
    if (!data || !this.client) return [];

    try {
      const result = await this.client.session.messages({
        sessionID: data.opencodeSessionId,
      });

      const allMessages = result.data ?? [];
      const events: SessionTraceEvent[] = [];

      for (const msg of allMessages) {
        const ts = new Date(msg.info?.time?.created ?? Date.now()).toISOString();
        const parts = Array.isArray(msg.parts) ? msg.parts : [];

        if (msg.info?.role === 'user') {
          const textParts = parts.filter(
            (p: unknown) =>
              p &&
              typeof p === 'object' &&
              (p as { type?: string }).type === 'text' &&
              typeof (p as { text?: string }).text === 'string',
          );
          const content = textParts
            .map((p) => (p as { text: string }).text)
            .join('\n');
          if (content) {
            events.push({ type: 'prompt', content, timestamp: ts });
          }
        } else if (msg.info?.role === 'assistant') {
          const textParts = parts.filter(
            (p: unknown) =>
              p &&
              typeof p === 'object' &&
              (p as { type?: string }).type === 'text' &&
              typeof (p as { text?: string }).text === 'string',
          );
          for (const p of textParts) {
            events.push({ type: 'text_delta', delta: (p as { text: string }).text, timestamp: ts });
          }

          const toolParts = parts.filter(
            (p: unknown) =>
              p &&
              typeof p === 'object' &&
              (p as Record<string, unknown>).type === 'tool' &&
              typeof (p as Record<string, unknown>).tool === 'string' &&
              (p as Record<string, unknown>).state !== undefined &&
              (p as Record<string, unknown>).state !== null &&
              typeof (p as Record<string, unknown>).state === 'object',
          );
          for (const p of toolParts) {
            const toolPart = p as {
              tool: string;
              state: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
            };
            events.push({
              type: 'tool_execution_start',
              toolName: toolPart.tool,
              args: toolPart.state.input,
              timestamp: ts,
            });
            events.push({
              type: 'tool_execution_end',
              toolName: toolPart.tool,
              isError: toolPart.state.status === 'error',
              result: toolPart.state.output ?? toolPart.state.error,
              error: toolPart.state.status === 'error' ? toolPart.state.error : undefined,
              timestamp: ts,
            });
          }
        }
      }

      return events;
    } catch (err) {
      console.error('Failed to get opencode session traces:', err);
      return [];
    }
  }

  async dispose(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.disposeSession(id).catch(() => {})));
    this.sessions.clear();
    this.sessionLocks.clear();

    if (this.ownsServer && this.server) {
      this.server.close();
    }
    this.client = undefined;
    this.server = undefined;
    this.initialized = false;
    this.initialization = undefined;
  }

  /** Resolves when the adapter has finished initializing its client/server. */
  ready(): Promise<void> {
    return this.ensureInitialized();
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
        const opencode = await createOpencode({
          hostname: config.embedded.hostname,
          port: config.embedded.port,
          config: config.embedded.config as never,
        });
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

  private async getOrCreateSession(
    sessionId: string,
  ): Promise<OpencodeSessionData> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const inFlight = this.sessionLocks.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.createOpencodeSession(sessionId)
      .then((data) => {
        this.sessions.set(sessionId, data);
        this.sessionLocks.delete(sessionId);
        return data;
      })
      .catch((err) => {
        this.sessionLocks.delete(sessionId);
        throw err;
      });

    this.sessionLocks.set(sessionId, promise);
    return promise;
  }

  private async createOpencodeSession(
    title: string,
  ): Promise<OpencodeSessionData> {
    if (!this.client) {
      throw new HarnessError(
        'Opencode client is not initialized',
        'HARNESS_FAILURE',
      );
    }

    const result = await this.client.session.create({
      title,
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
    return parts
      .filter((part): part is Part & { type: 'text'; text: string } => {
        if (!part || typeof part !== 'object') return false;
        const p = part as Record<string, unknown>;
        return p.type === 'text' && typeof p.text === 'string';
      })
      .map((part) => part.text)
      .join('');
  }

  private tryParseStructured(
    structured: unknown,
  ): Record<string, unknown> | undefined {
    if (
      structured &&
      typeof structured === 'object' &&
      !Array.isArray(structured)
    ) {
      return structured as Record<string, unknown>;
    }
    return undefined;
  }

  private toResourceUsage(
    info: AssistantMessage | undefined,
  ): {
    spend?: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  } {
    if (!info) return {};

    const spend = info.cost;
    const tokens = info.tokens;
    const totalTokens = tokens?.total ?? (tokens?.input ?? 0) + (tokens?.output ?? 0);

    return {
      spend: typeof spend === 'number' ? Math.round(spend * 1_000_000) : undefined,
      tokens: totalTokens || undefined,
      inputTokens: tokens?.input,
      outputTokens: tokens?.output,
    };
  }
}
