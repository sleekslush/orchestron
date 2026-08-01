import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { PiAdapter } from './pi-adapter.js';
import type { HarnessResponse } from '@orchestron/core';

const mockSession = {
  subscribe: vi.fn(() => vi.fn()),
  prompt: vi.fn(),
  dispose: vi.fn(),
  abort: vi.fn(),
};

const createAgentSessionMock = vi.fn() as Mock<
  (options?: Record<string, unknown>) => Promise<{ session: typeof mockSession; extensionsResult: unknown }>
>;
createAgentSessionMock.mockImplementation(async () => ({ session: mockSession, extensionsResult: {} }));

const modelRuntimeGetModelMock = vi.fn() as Mock<(provider: string, modelId: string) => unknown>;
const modelRuntimeGetModelsMock = vi.fn() as Mock<() => unknown[]>;

const mockModelRuntime = {
  getModel: modelRuntimeGetModelMock,
  getModels: modelRuntimeGetModelsMock,
};

const modelRuntimeCreateMock = vi.fn() as Mock<() => Promise<unknown>>;
modelRuntimeCreateMock.mockResolvedValue(mockModelRuntime);

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: (...args: unknown[]) => modelRuntimeCreateMock(...args as Parameters<typeof modelRuntimeCreateMock>) },
  SessionManager: { inMemory: vi.fn(() => ({ id: 'manager' })) },
  createAgentSession: (...args: unknown[]) => createAgentSessionMock(...args as Parameters<typeof createAgentSessionMock>),
}));

describe('PiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAgentSessionMock.mockResolvedValue({ session: mockSession, extensionsResult: {} });
    modelRuntimeCreateMock.mockResolvedValue(mockModelRuntime);
  });

  it('executes a prompt without sessionId using a fresh session', async () => {
    mockSession.prompt.mockResolvedValueOnce(undefined);
    const adapter = new PiAdapter();

    const result = await adapter.execute('hello', { shared: {} });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(mockSession.prompt).toHaveBeenCalledWith('hello');
    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('');
  });

  it('reuses sessions for the same sessionId and does not dispose them', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('first', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('second', { shared: {} }, { sessionId: 'c1:m1' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(mockSession.prompt).toHaveBeenCalledTimes(2);
    expect(mockSession.dispose).not.toHaveBeenCalled();
  });

  it('creates separate sessions for different sessionIds', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
  });

  it('releases the session lock if creation fails', async () => {
    createAgentSessionMock.mockRejectedValueOnce(new Error('boom'));
    const adapter = new PiAdapter();

    await expect(adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' })).rejects.toThrow();

    // A subsequent call should retry creation instead of reusing the rejected promise.
    createAgentSessionMock.mockResolvedValueOnce({ session: mockSession, extensionsResult: {} });
    mockSession.prompt.mockResolvedValue(undefined);
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m1' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
  });

  it('disposes a tracked session via disposeSession', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('x', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.disposeSession('c1:m1');

    expect(mockSession.dispose).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it('disposes all tracked sessions via dispose', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' });
    await adapter.dispose();

    expect(mockSession.dispose).toHaveBeenCalledTimes(2);
  });

  it('injects schema instructions for structured output', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema },
    });

    const prompt = (mockSession.prompt as Mock).mock.calls[0][0] as string;
    expect(prompt).toContain('do it');
    expect(prompt).toContain('JSON object conforming to this schema');
    expect(prompt).toContain(JSON.stringify(schema, null, 2));
  });

  it('parses structured output from a markdown JSON block', async () => {
    let messageHandler: ((event: unknown) => void) | undefined;
    const capturingSession = {
      ...mockSession,
      subscribe: vi.fn((handler) => {
        messageHandler = handler;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        messageHandler?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '```json\n{"ok":true}\n```' },
        });
        messageHandler?.({ type: 'agent_end', messages: [], willRetry: false });
      }),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: capturingSession, extensionsResult: {} });

    const adapter = new PiAdapter();
    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('forwards tool execution events to onProgress', async () => {
    let messageHandler: ((event: unknown) => void) | undefined;
    const capturingSession = {
      ...mockSession,
      subscribe: vi.fn((handler) => {
        messageHandler = handler;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        messageHandler?.({
          type: 'tool_execution_start',
          toolCallId: 'tc-1',
          toolName: 'git_status',
          args: {},
        });
        messageHandler?.({
          type: 'tool_execution_end',
          toolCallId: 'tc-1',
          toolName: 'git_status',
          result: {},
          isError: false,
        });
        messageHandler?.({ type: 'agent_end', messages: [], willRetry: false });
      }),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: capturingSession, extensionsResult: {} });

    const onProgress = vi.fn();
    const adapter = new PiAdapter();
    await adapter.execute('do it', { shared: {} }, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'tool_execution_start',
      toolName: 'git_status',
      args: undefined,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'tool_execution_end',
      toolName: 'git_status',
      isError: false,
      result: {},
      error: undefined,
    });
  });

  it('forwards text deltas to onProgress', async () => {
    let messageHandler: ((event: unknown) => void) | undefined;
    const capturingSession = {
      ...mockSession,
      subscribe: vi.fn((handler) => {
        messageHandler = handler;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        messageHandler?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
        });
        messageHandler?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'world' },
        });
        messageHandler?.({ type: 'agent_end', messages: [], willRetry: false });
      }),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: capturingSession, extensionsResult: {} });

    const onProgress = vi.fn();
    const adapter = new PiAdapter();
    await adapter.execute('do it', { shared: {} }, { onProgress });

    expect(onProgress).toHaveBeenNthCalledWith(1, { type: 'text_delta', delta: 'Hello ' });
    expect(onProgress).toHaveBeenNthCalledWith(2, { type: 'text_delta', delta: 'world' });
  });

  it('extracts resource usage from agent_end messages', async () => {
    let messageHandler: ((event: unknown) => void) | undefined;
    const capturingSession = {
      ...mockSession,
      subscribe: vi.fn((handler) => {
        messageHandler = handler;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        messageHandler?.({
          type: 'agent_end',
          messages: [{ role: 'assistant', content: 'hi', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.00012, input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0 } } }],
          willRetry: false,
        });
      }),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: capturingSession, extensionsResult: {} });

    const adapter = new PiAdapter();
    const result = await adapter.execute('hi', { shared: {} });

    expect(result.usage).toEqual({
      spend: 120,
      tokens: 8,
      inputTokens: 5,
      outputTokens: 3,
    });
  });

  it('falls back to getLastAssistantText when no text deltas were captured', async () => {
    const noTextSession = {
      ...mockSession,
      prompt: vi.fn(async () => {
        // No message_update events emitted, so output stays empty.
      }),
      getLastAssistantText: vi.fn(() => '{"review": "looks good"}'),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: noTextSession, extensionsResult: {} });

    const adapter = new PiAdapter();
    const result = await adapter.execute('review', { shared: {} });

    expect(result.output).toBe('{"review": "looks good"}');
    expect(result.summary).toBe('{"review": "looks good"}');
  });

  it('aborts the session when the signal is aborted', async () => {
    let rejectPrompt: ((err: Error) => void) | undefined;
    const abortableSession = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectPrompt = reject;
          }),
      ),
      dispose: vi.fn(),
      abort: vi.fn(() => {
        rejectPrompt?.(new Error('aborted'));
      }),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session: abortableSession, extensionsResult: {} });

    const adapter = new PiAdapter();
    const controller = new AbortController();

    const promise = adapter.execute('slow', { shared: {} }, { signal: controller.signal });
    await vi.waitFor(() => expect(abortableSession.prompt).toHaveBeenCalled());
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'HARNESS_TIMEOUT' });
    expect(abortableSession.abort).toHaveBeenCalled();
  });

  it('removes the abort listener after execute finishes', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();
    const controller = new AbortController();

    await adapter.execute('x', { shared: {} }, { signal: controller.signal });
    controller.abort();

    expect(mockSession.abort).not.toHaveBeenCalled();
  });

  it('throws HARNESS_FAILURE when model is not found', async () => {
    modelRuntimeGetModelMock.mockReturnValue(undefined);

    const adapter = new PiAdapter({ provider: 'openai', modelId: 'gpt-4o' });

    await expect(adapter.execute('x', { shared: {} })).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining("Unknown Pi model 'gpt-4o' for provider 'openai'"),
    });
  });

  it('validates per-execution model options instead of config defaults', async () => {
    modelRuntimeGetModelMock.mockReturnValue(undefined);

    const adapter = new PiAdapter({ provider: 'openai', modelId: 'gpt-4o' });

    await expect(
      adapter.execute('x', { shared: {} }, { provider: 'anthropic', model: 'claude-opus' }),
    ).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining("Unknown Pi model 'claude-opus' for provider 'anthropic'"),
    });
  });

  it('resolves models via ModelRuntime and passes modelRuntime to the session', async () => {
    const resolvedModel = { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash-0731' };
    modelRuntimeGetModelMock.mockReturnValue(resolvedModel);
    mockSession.prompt.mockResolvedValue(undefined);

    const adapter = new PiAdapter({ provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' });
    await adapter.execute('x', { shared: {} });

    expect(modelRuntimeGetModelMock).toHaveBeenCalledWith(
      'openrouter',
      'deepseek/deepseek-v4-flash-0731',
    );
    const options = createAgentSessionMock.mock.calls[0]?.[0];
    expect(options!.model).toEqual(resolvedModel);
    expect(options!.modelRuntime).toBe(mockModelRuntime);
    expect(options!).not.toHaveProperty('modelRegistry');
    expect(options!).not.toHaveProperty('authStorage');
  });

  it('creates ModelRuntime with allowModelNetwork enabled', async () => {
    modelRuntimeCreateMock.mockClear();
    mockSession.prompt.mockResolvedValue(undefined);

    const adapter = new PiAdapter();
    await adapter.execute('a', { shared: {} });

    expect(modelRuntimeCreateMock).toHaveBeenCalledWith({ allowModelNetwork: true });
  });

  it('shares a single ModelRuntime across sessions', async () => {
    modelRuntimeCreateMock.mockClear();
    mockSession.prompt.mockResolvedValue(undefined);

    const adapter = new PiAdapter();
    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' });

    expect(modelRuntimeCreateMock).toHaveBeenCalledTimes(1);
  });

  it('omits tools by default so Pi uses built-in defaults', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('x', { shared: {} });

    const options = createAgentSessionMock.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options!).not.toHaveProperty('tools');
    expect(options!).not.toHaveProperty('excludeTools');
  });

  it('passes configured tool allowlist and denylist', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter({ tools: ['read'], excludeTools: ['bash'] });

    await adapter.execute('x', { shared: {} });

    const options = createAgentSessionMock.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options!.tools).toEqual(['read']);
    expect(options!.excludeTools).toEqual(['bash']);
  });

  it('lists models from the shared ModelRuntime', async () => {
    modelRuntimeGetModelsMock.mockReturnValue([
      { id: 'claude-3', provider: 'anthropic', name: 'Claude 3' },
      { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o' },
      { id: 'deepseek/deepseek-v4-flash-0731', provider: 'openrouter' },
    ]);
    const adapter = new PiAdapter();

    const models = await adapter.listModels();

    expect(models).toEqual([
      { provider: 'anthropic', model: 'claude-3' },
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
    ]);
  });

  it('passes thinkingLevel to a fresh session', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('x', { shared: {} }, { options: { thinkingLevel: 'high' } });

    const options = createAgentSessionMock.mock.calls[0]?.[0];
    expect(options!.thinkingLevel).toBe('high');
  });

  it('sets thinkingLevel on a reused session before prompting', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const setThinkingLevel = vi.fn();
    const sessionWithLevel = { ...mockSession, setThinkingLevel };
    createAgentSessionMock.mockResolvedValueOnce({ session: sessionWithLevel, extensionsResult: {} });

    const adapter = new PiAdapter();
    await adapter.execute('first', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('second', { shared: {} }, { sessionId: 'c1:m1', options: { thinkingLevel: 'low' } });

    expect(setThinkingLevel).toHaveBeenCalledWith('low');
  });

  it('does not set a thinking level when none is provided', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const setThinkingLevel = vi.fn();
    const sessionWithLevel = { ...mockSession, setThinkingLevel };
    createAgentSessionMock.mockResolvedValueOnce({ session: sessionWithLevel, extensionsResult: {} });

    const adapter = new PiAdapter();
    await adapter.execute('first', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('second', { shared: {} }, { sessionId: 'c1:m1' });

    expect(setThinkingLevel).not.toHaveBeenCalled();
  });

  it('throws HARNESS_FAILURE for an invalid thinking level', async () => {
    const adapter = new PiAdapter();

    await expect(
      adapter.execute('x', { shared: {} }, { options: { thinkingLevel: 'ultra' } }),
    ).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining("Invalid Pi thinking level 'ultra'"),
    });
  });
});

describe('PiAdapter cwd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAgentSessionMock.mockResolvedValue({ session: mockSession, extensionsResult: {} });
    modelRuntimeCreateMock.mockResolvedValue(mockModelRuntime);
  });

  it('passes cwd to createAgentSession for an ephemeral session', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('hello', { shared: {} }, { cwd: '/worktree/path' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const sessionOptions = (createAgentSessionMock as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(sessionOptions.cwd).toBe('/worktree/path');
  });

  it('passes cwd to createAgentSession for a pooled session', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('hello', { shared: {} }, { sessionId: 'c1:m1', cwd: '/worktree/path' });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const sessionOptions = (createAgentSessionMock as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(sessionOptions.cwd).toBe('/worktree/path');
  });

  it('does not pass cwd when none is provided', async () => {
    mockSession.prompt.mockResolvedValue(undefined);
    const adapter = new PiAdapter();

    await adapter.execute('hello', { shared: {} });

    const sessionOptions = (createAgentSessionMock as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(sessionOptions.cwd).toBeUndefined();
  });
});
