import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeAdapter } from './opencode-adapter.js';
import type { HarnessResponse } from '@orchestron/core';

const mockModelList = vi.fn();

const mockClient = {
  session: {
    create: vi.fn(),
    promptAsync: vi.fn(),
    delete: vi.fn(),
    abort: vi.fn(),
    messages: vi.fn(),
  },
  event: {
    subscribe: vi.fn(),
  },
  v2: {
    model: {
      list: (...args: unknown[]) => mockModelList(...args),
    },
  },
};

const mockServer = {
  url: 'http://localhost:4096',
  close: vi.fn(),
};

const createOpencodeClientMock = vi.fn() as Mock;
const createOpencodeMock = vi.fn() as Mock;

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: (config: unknown) => createOpencodeClientMock(config),
  createOpencode: (options: unknown) => createOpencodeMock(options),
}));

function makeTextPart(text: string) {
  return { type: 'text', text } as unknown;
}

function makeAssistantMessage(
  overrides: {
    cost?: number;
    tokens?: { input?: number; output?: number; total?: number };
    structured?: unknown;
  } = {},
) {
  return {
    id: 'msg-1',
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: Date.now() },
    parentID: 'parent-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'chat',
    agent: 'agent-1',
    path: { cwd: '/', root: '/' },
    cost: overrides.cost ?? 0,
    tokens: {
      input: overrides.tokens?.input ?? 0,
      output: overrides.tokens?.output ?? 0,
      total: overrides.tokens?.total,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    structured: overrides.structured,
  };
}

describe('OpencodeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOpencodeClientMock.mockReturnValue(mockClient);
    createOpencodeMock.mockResolvedValue({ client: mockClient, server: mockServer });
    mockClient.session.create.mockResolvedValue({
      data: { id: 'session-1', title: 'test' },
    });
    mockClient.session.promptAsync.mockResolvedValue({ data: {} });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ cost: 0.00012, tokens: { input: 5, output: 3, total: 8 } }),
          parts: [makeTextPart('hello')],
        },
      ],
    });
    // Default: event subscription is unavailable, so execute falls back to the
    // post-hoc session trace (session.messages). Tests exercise the live event
    // stream by overriding subscribe explicitly.
    mockClient.event.subscribe.mockRejectedValue(new Error('subscription unavailable'));
    mockClient.session.delete.mockResolvedValue({ data: true });
    mockClient.session.abort.mockResolvedValue({ data: true });
    mockModelList.mockResolvedValue({
      data: {
        data: [
          { id: 'claude-3', providerID: 'anthropic', name: 'Claude 3' },
          { id: 'gpt-4o', providerID: 'openai', name: 'GPT-4o' },
        ],
      },
    });
  });

  it('executes a prompt without sessionId using a fresh session', async () => {
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hello', { shared: {} });

    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4096' });
    expect(mockClient.session.create).toHaveBeenCalledWith({ title: 'ephemeral' });
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: 'session-1', parts: [{ type: 'text', text: 'hello' }] }),
    );
    expect(mockClient.session.delete).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(result.output).toBe('hello');
  });

  it('reuses sessions for the same sessionId and does not delete them', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('first', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('second', { shared: {} }, { sessionId: 'c1:m1' });

    expect(mockClient.session.create).toHaveBeenCalledTimes(1);
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(mockClient.session.delete).not.toHaveBeenCalled();
  });

  it('creates separate sessions for different sessionIds', async () => {
    mockClient.session.create
      .mockResolvedValueOnce({ data: { id: 's1' } })
      .mockResolvedValueOnce({ data: { id: 's2' } });
    const adapter = new OpencodeAdapter();

    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' });

    expect(mockClient.session.create).toHaveBeenCalledTimes(2);
  });

  it('releases the session lock if creation fails', async () => {
    mockClient.session.create.mockRejectedValueOnce(new Error('boom'));
    const adapter = new OpencodeAdapter();

    await expect(adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' })).rejects.toThrow();

    mockClient.session.create.mockResolvedValueOnce({ data: { id: 's1' } });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m1' });

    expect(mockClient.session.create).toHaveBeenCalledTimes(2);
  });

  it('deletes a tracked session via disposeSession', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.disposeSession('c1:m1');

    expect(mockClient.session.delete).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(mockClient.session.delete).toHaveBeenCalledTimes(1);
  });

  it('deletes all tracked sessions and closes embedded server via dispose', async () => {
    createOpencodeMock.mockResolvedValue({ client: mockClient, server: mockServer });
    const adapter = new OpencodeAdapter({ embedded: {} });

    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' });
    await adapter.dispose();

    expect(mockClient.session.delete).toHaveBeenCalledTimes(2);
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  it('does not close server on dispose when using existing server', async () => {
    const adapter = new OpencodeAdapter({ baseUrl: 'http://custom:1234' });

    await adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' });
    await adapter.dispose();

    expect(mockServer.close).not.toHaveBeenCalled();
    expect(mockClient.session.delete).toHaveBeenCalledTimes(1);
  });

  it('uses native json_schema format for structured output', async () => {
    const adapter = new OpencodeAdapter();
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema },
    });

    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt).toMatchObject({
      parts: [{ type: 'text', text: 'do it' }],
      format: { type: 'json_schema', schema },
    });
  });

  it('returns structured output from response info.structured', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ structured: { ok: true } }),
          parts: [makeTextPart('{"ok":true}')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('parses structured output from a string in info.structured', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ structured: '{"ok":true}' }),
          parts: [makeTextPart('{"ok":true}')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('falls back to parsing structured output from text parts when info.structured is missing', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage(),
          parts: [makeTextPart('```json\n{"ok":true}\n```')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('falls back to parsing raw JSON object from text parts', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage(),
          parts: [makeTextPart('Some intro {"ok":true} outro')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('extracts resource usage from response info', async () => {
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hi', { shared: {} });

    expect(result.usage).toEqual({
      spend: 120,
      tokens: 8,
      inputTokens: 5,
      outputTokens: 3,
    });
  });

  it('falls back to input+output when total tokens is missing', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ cost: 0.0001, tokens: { input: 3, output: 2 } }),
          parts: [makeTextPart('hi')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hi', { shared: {} });

    expect(result.usage.tokens).toBe(5);
  });

  it('aggregates usage across all assistant messages in a turn', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ cost: 0.0001, tokens: { input: 10, output: 5, total: 15 } }),
          parts: [makeTextPart('intermediate')],
        },
        {
          info: makeAssistantMessage({ cost: 0.0002, tokens: { input: 3, output: 2, total: 5 } }),
          parts: [makeTextPart('final')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hi', { shared: {} });

    expect(result.output).toBe('final');
    // cost (0.0001 + 0.0002) * 1e6 = 300 micro; tokens summed across both steps.
    expect(result.usage).toEqual({
      spend: 300,
      tokens: 20,
      inputTokens: 13,
      outputTokens: 7,
    });
  });

  it('leaves spend undefined when the server omits cost', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            ...makeAssistantMessage({ tokens: { input: 10, output: 5, total: 15 } }),
            cost: undefined,
          },
          parts: [makeTextPart('final')],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hi', { shared: {} });

    expect(result.usage.spend).toBeUndefined();
    expect(result.usage.tokens).toBe(15);
  });

  it('aggregates only the current turn when reusing a persistent session', async () => {
    const prior = makeAssistantMessage({ cost: 0.01, tokens: { input: 100, output: 50, total: 150 } });
    const current = makeAssistantMessage({ cost: 0.0001, tokens: { input: 5, output: 3, total: 8 } });

    // First call (turn-boundary capture before the prompt) returns only the
    // prior turn; subsequent polls include the new turn.
    mockClient.session.messages
      .mockResolvedValueOnce({ data: [{ info: prior, parts: [makeTextPart('old')] }] })
      .mockResolvedValue({
        data: [
          { info: prior, parts: [makeTextPart('old')] },
          { info: current, parts: [makeTextPart('new')] },
        ],
      });
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('second', { shared: {} }, { sessionId: 'c1:m1' });

    expect(result.output).toBe('new');
    // Only the current turn's message is counted, not the prior turn.
    expect(result.usage).toEqual({ spend: 100, tokens: 8, inputTokens: 5, outputTokens: 3 });
  });

  it('aborts the session when the signal is aborted', async () => {
    let rejectPrompt: ((err: Error) => void) | undefined;
    mockClient.session.promptAsync.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPrompt = reject;
        }),
    );
    const adapter = new OpencodeAdapter();

    const controller = new AbortController();
    const promise = adapter.execute('slow', { shared: {} }, { signal: controller.signal });

    await vi.waitFor(() => expect(mockClient.session.promptAsync).toHaveBeenCalled());
    mockClient.session.abort.mockImplementation(() => {
      rejectPrompt?.(new Error('aborted'));
      return { data: true };
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'HARNESS_TIMEOUT' });
    expect(mockClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' });
  });

  it('removes the abort listener after execute finishes', async () => {
    const adapter = new OpencodeAdapter();
    const controller = new AbortController();

    await adapter.execute('x', { shared: {} }, { signal: controller.signal });
    controller.abort();

    expect(mockClient.session.abort).not.toHaveBeenCalled();
  });

  it('throws HARNESS_FAILURE when initialization fails', async () => {
    createOpencodeClientMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const adapter = new OpencodeAdapter();

    await expect(adapter.execute('x', { shared: {} })).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
    });
  });

  it('passes model provider and id when configured', async () => {
    const adapter = new OpencodeAdapter({ provider: 'anthropic', modelId: 'claude-3' });

    await adapter.execute('x', { shared: {} });

    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.model).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
  });

  it('passes tools as a boolean map when configured', async () => {
    const adapter = new OpencodeAdapter({ tools: ['read', 'edit'] });

    await adapter.execute('x', { shared: {} });

    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.tools).toEqual({ read: true, edit: true });
  });

  it('connects to custom baseUrl when provided', async () => {
    const adapter = new OpencodeAdapter({ baseUrl: 'http://custom:1234' });
    await adapter.ready();

    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: 'http://custom:1234' });
  });

  it('starts embedded server when embedded config is provided', async () => {
    const adapter = new OpencodeAdapter({ embedded: { hostname: '127.0.0.1', port: 4097 } });
    await adapter.ready();

    expect(createOpencodeMock).toHaveBeenCalledWith({ hostname: '127.0.0.1', port: 4097, config: undefined });
  });

  it('retries initialization after a failure', async () => {
    createOpencodeClientMock.mockReset();
    let attempts = 0;
    createOpencodeClientMock.mockImplementation(() => {
      attempts++;
      if (attempts === 1) throw new Error('server not ready');
      return mockClient;
    });

    const adapter = new OpencodeAdapter({ baseUrl: 'http://localhost:4096' });
    await expect(adapter.execute('x', { shared: {} })).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
    });

    await adapter.execute('y', { shared: {} });
    expect(attempts).toBe(2);
  });

  it('handles concurrent execute calls with different sessionIds', async () => {
    mockClient.session.create
      .mockResolvedValueOnce({ data: { id: 's1' } })
      .mockResolvedValueOnce({ data: { id: 's2' } })
      .mockResolvedValueOnce({ data: { id: 's3' } });
    const adapter = new OpencodeAdapter();

    const [r1, r2, r3] = await Promise.all([
      adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' }),
      adapter.execute('b', { shared: {} }, { sessionId: 'c1:m2' }),
      adapter.execute('c', { shared: {} }, { sessionId: 'c1:m3' }),
    ]);

    expect(mockClient.session.create).toHaveBeenCalledTimes(3);
    expect(r1.output).toBe('hello');
    expect(r2.output).toBe('hello');
    expect(r3.output).toBe('hello');
    expect(mockClient.session.delete).not.toHaveBeenCalled();
  });

  it('getSessionTraceEvents ignores tool parts with null state', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: { role: 'assistant', time: { created: Date.now() } },
          parts: [
            makeTextPart('hello'),
            { type: 'tool', tool: 'git_status', state: null },
            { type: 'tool', tool: 'read', state: { status: 'success', input: { path: 'a.ts' }, output: 'content' } },
          ],
        },
      ],
    });
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} }, { sessionId: 'c1:m1' });
    const events = await adapter.getSessionTraceEvents('c1:m1');

    expect(events).toHaveLength(3); // text_delta + tool_execution_start + tool_execution_end
    expect(events[0].type).toBe('text_delta');
    expect(events[1].type).toBe('tool_execution_start');
    expect((events[1] as any).toolName).toBe('read');
    expect(events[2].type).toBe('tool_execution_end');
    expect((events[2] as any).toolName).toBe('read');
  });

  it('validates model before prompt when model and provider are specified', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} }, { provider: 'anthropic', model: 'claude-3' });

    expect(mockModelList).toHaveBeenCalled();
    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.model).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
  });

  it('throws HARNESS_FAILURE when model is not in the server catalog', async () => {
    const adapter = new OpencodeAdapter();

    await expect(
      adapter.execute('x', { shared: {} }, { provider: 'openai', model: 'gpt-999' }),
    ).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining("does not recognize model 'gpt-999' for provider 'openai'"),
    });
  });

  it('throws HARNESS_FAILURE when server is unreachable during model validation', async () => {
    mockModelList.mockRejectedValueOnce(new Error('connection refused'));
    const adapter = new OpencodeAdapter();

    await expect(
      adapter.execute('x', { shared: {} }, { provider: 'anthropic', model: 'claude-3' }),
    ).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining(
        "Cannot verify model 'claude-3' for provider 'anthropic'",
      ),
    });

    // Prompt must not be reached when validation fails.
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled();
  });

  it('skips model validation when no model is specified', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} });

    expect(mockModelList).not.toHaveBeenCalled();
  });

  it('caches model catalog and only fetches once', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('a', { shared: {} }, { provider: 'anthropic', model: 'claude-3' });
    await adapter.execute('b', { shared: {} }, { provider: 'openai', model: 'gpt-4o' });

    expect(mockModelList).toHaveBeenCalledTimes(1);
  });

  it('clears model cache on dispose', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('a', { shared: {} }, { provider: 'anthropic', model: 'claude-3' });
    await adapter.dispose();

    // After dispose, cache is cleared — will fetch again
    await adapter.execute('b', { shared: {} }, { provider: 'openai', model: 'gpt-4o' });
    expect(mockModelList).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent execute calls for the same sessionId', async () => {
    let createCount = 0;
    mockClient.session.create.mockImplementation(() => {
      createCount++;
      return Promise.resolve({ data: { id: `s${createCount}` } });
    });
    const adapter = new OpencodeAdapter();

    const [r1, r2] = await Promise.all([
      adapter.execute('a', { shared: {} }, { sessionId: 'c1:m1' }),
      adapter.execute('b', { shared: {} }, { sessionId: 'c1:m1' }),
    ]);

    expect(createCount).toBe(1);
    expect(r1.output).toBe('hello');
    expect(r2.output).toBe('hello');
  });

  it('lists models from the server catalog', async () => {
    const adapter = new OpencodeAdapter();

    const models = await adapter.listModels();

    expect(mockModelList).toHaveBeenCalledTimes(1);
    expect(models).toEqual([
      { provider: 'anthropic', model: 'claude-3' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
  });

  it('caches the catalog across listModels calls', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.listModels();
    await adapter.listModels();

    expect(mockModelList).toHaveBeenCalledTimes(1);
  });

  it('shares the catalog cache with model validation', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.listModels();
    await adapter.execute('x', { shared: {} }, { provider: 'anthropic', model: 'claude-3' });

    expect(mockModelList).toHaveBeenCalledTimes(1);
  });

  it('throws HARNESS_FAILURE when the catalog fetch fails', async () => {
    mockModelList.mockRejectedValueOnce(new Error('connection refused'));
    const adapter = new OpencodeAdapter();

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining('Failed to fetch opencode models'),
    });
  });

  it('passes options.variant to the prompt', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} }, { options: { variant: 'effort-high' } });

    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.variant).toBe('effort-high');
  });

  it('omits variant when options.variant is missing', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('x', { shared: {} });

    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.variant).toBeUndefined();
  });

  it('streams text deltas and tool calls from the event subscription', async () => {
    const events = [
      { type: 'session.next.text.delta', properties: { sessionID: 'session-1', delta: 'Hello ' } },
      { type: 'session.next.text.delta', properties: { sessionID: 'session-1', delta: 'world' } },
      { type: 'session.next.tool.called', properties: { sessionID: 'session-1', callID: 'c1', tool: 'read', input: { path: 'a.ts' } } },
      { type: 'session.next.tool.success', properties: { sessionID: 'session-1', callID: 'c1', result: 'content' } },
      { type: 'session.next.step.ended', properties: { sessionID: 'session-1' } },
    ];
    mockClient.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        for (const e of events) yield e;
      })(),
    });
    const adapter = new OpencodeAdapter();
    const onProgress = vi.fn();

    await adapter.execute('x', { shared: {} }, { onProgress });

    expect(onProgress).toHaveBeenCalledWith({ type: 'text_delta', delta: 'Hello ' });
    expect(onProgress).toHaveBeenCalledWith({ type: 'text_delta', delta: 'world' });
    expect(onProgress).toHaveBeenCalledWith({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { path: 'a.ts' },
    });
    expect(onProgress).toHaveBeenCalledWith({
      type: 'tool_execution_end',
      toolName: 'read',
      isError: false,
      result: 'content',
    });
  });

  it('reports tool failures from the event subscription', async () => {
    mockClient.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        yield {
          type: 'session.next.tool.failed',
          properties: { sessionID: 'session-1', callID: 'c1', error: { message: 'boom' } },
        };
        yield { type: 'session.next.step.ended', properties: { sessionID: 'session-1' } };
      })(),
    });
    const adapter = new OpencodeAdapter();
    const onProgress = vi.fn();

    await adapter.execute('x', { shared: {} }, { onProgress });

    expect(onProgress).toHaveBeenCalledWith({
      type: 'tool_execution_end',
      toolName: 'unknown',
      isError: true,
      error: 'boom',
    });
  });

  it('ignores events from other sessions in the event subscription', async () => {
    const events = [
      { type: 'session.next.text.delta', properties: { sessionID: 'other', delta: 'ignored' } },
      { type: 'session.next.step.ended', properties: { sessionID: 'session-1' } },
    ];
    mockClient.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        for (const e of events) yield e;
      })(),
    });
    const adapter = new OpencodeAdapter();
    const onProgress = vi.fn();

    await adapter.execute('x', { shared: {} }, { onProgress });

    // Only the step.ended for our session applies; the foreign text delta is dropped.
    expect(onProgress).not.toHaveBeenCalledWith({ type: 'text_delta', delta: 'ignored' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('fails when the event subscription reports a failed step', async () => {
    mockClient.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        yield {
          type: 'session.next.step.failed',
          properties: { sessionID: 'session-1', error: { message: 'errored' } },
        };
      })(),
    });
    const adapter = new OpencodeAdapter();

    await expect(adapter.execute('x', { shared: {} })).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining('errored'),
    });
  });
});

  it('passes directory to session.create when cwd is provided', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('hello', { shared: {} }, { cwd: '/worktree/path' });

    expect(mockClient.session.create).toHaveBeenCalledWith({
      title: 'ephemeral',
      directory: '/worktree/path',
    });
  });

  it('passes directory for a pooled session created with a cwd', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('hello', { shared: {} }, { sessionId: 'c1:m1', cwd: '/worktree/path' });

    expect(mockClient.session.create).toHaveBeenCalledWith({
      title: 'c1:m1',
      directory: '/worktree/path',
    });
  });

  it('omits directory when no cwd is provided', async () => {
    const adapter = new OpencodeAdapter();

    await adapter.execute('hello', { shared: {} });

    expect(mockClient.session.create).toHaveBeenCalledWith({ title: 'ephemeral' });
  });

describe('OpencodeAdapter skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOpencodeClientMock.mockReturnValue(mockClient);
    mockClient.session.create.mockResolvedValue({ data: { id: 'session-1', title: 'test' } });
    mockClient.session.promptAsync.mockResolvedValue({ data: {} });
    mockClient.session.messages.mockResolvedValue({
      data: [
        {
          info: makeAssistantMessage({ cost: 0.00012, tokens: { input: 5, output: 3, total: 8 } }),
          parts: [makeTextPart('hello')],
        },
      ],
    });
  });

  it('registers declared skills in the session and injects their content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-skills-'));
    mkdirSync(join(dir, 'review-conventions'));
    writeFileSync(
      join(dir, 'review-conventions', 'SKILL.md'),
      '---\nname: review-conventions\n---\n\nCheck correctness and edge cases.',
    );

    const adapter = new OpencodeAdapter();
    await adapter.execute('review this', { shared: {} }, {
      sessionId: 'c1:m1',
      skills: ['review-conventions'],
      skillsDir: dir,
    });

    // Skill is registered on the session (persistent → survives cleanup).
    expect(adapter.getRegisteredSkills('session-1').map((s) => s.name)).toEqual(['review-conventions']);

    // Skill content is injected into the session's prompt at creation time.
    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    const text = prompt.parts[0].text as string;
    expect(text).toContain('review this');
    expect(text).toContain('Check correctness and edge cases.');
  });

  it('does not register skills when none are declared', async () => {
    const adapter = new OpencodeAdapter();
    await adapter.execute('x', { shared: {} }, { sessionId: 'c1:m1' });

    expect(adapter.getRegisteredSkills('session-1')).toEqual([]);
    const prompt = (mockClient.session.promptAsync as Mock).mock.calls[0][0];
    expect(prompt.parts[0].text).toBe('x');
  });

  it('fails loudly when a declared skill cannot be resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-skills-'));
    const adapter = new OpencodeAdapter();

    await expect(
      adapter.execute('x', { shared: {} }, { sessionId: 'c1:m1', skills: ['missing-skill'], skillsDir: dir }),
    ).rejects.toMatchObject({
      code: 'HARNESS_FAILURE',
      message: expect.stringContaining('missing-skill'),
    });
    // Must not run the session without the skill.
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled();
  });
});
