import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { OpencodeAdapter } from './opencode-adapter.js';
import type { HarnessResponse } from '@orchestron/core';

const mockClient = {
  session: {
    create: vi.fn(),
    prompt: vi.fn(),
    delete: vi.fn(),
    abort: vi.fn(),
    messages: vi.fn(),
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
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage({ cost: 0.00012, tokens: { input: 5, output: 3, total: 8 } }),
        parts: [makeTextPart('hello')],
      },
    });
    mockClient.session.delete.mockResolvedValue({ data: true });
    mockClient.session.abort.mockResolvedValue({ data: true });
  });

  it('executes a prompt without sessionId using a fresh session', async () => {
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hello', { shared: {} });

    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4096' });
    expect(mockClient.session.create).toHaveBeenCalledWith({ title: 'ephemeral' });
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
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
    expect(mockClient.session.prompt).toHaveBeenCalledTimes(2);
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

    const prompt = (mockClient.session.prompt as Mock).mock.calls[0][0];
    expect(prompt).toMatchObject({
      parts: [{ type: 'text', text: 'do it' }],
      format: { type: 'json_schema', schema },
    });
  });

  it('returns structured output from response info.structured', async () => {
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage({ structured: { ok: true } }),
        parts: [makeTextPart('{"ok":true}')],
      },
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('parses structured output from a string in info.structured', async () => {
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage({ structured: '{"ok":true}' }),
        parts: [makeTextPart('{"ok":true}')],
      },
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('falls back to parsing structured output from text parts when info.structured is missing', async () => {
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage(),
        parts: [makeTextPart('```json\n{"ok":true}\n```')],
      },
    });
    const adapter = new OpencodeAdapter();

    const result: HarnessResponse = await adapter.execute('do it', { shared: {} }, {
      output: { mode: 'structured', schema: { type: 'object' } },
    });

    expect(result.structured).toEqual({ ok: true });
  });

  it('falls back to parsing raw JSON object from text parts', async () => {
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage(),
        parts: [makeTextPart('Some intro {"ok":true} outro')],
      },
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
    mockClient.session.prompt.mockResolvedValue({
      data: {
        info: makeAssistantMessage({ cost: 0.0001, tokens: { input: 3, output: 2 } }),
        parts: [makeTextPart('hi')],
      },
    });
    const adapter = new OpencodeAdapter();

    const result = await adapter.execute('hi', { shared: {} });

    expect(result.usage.tokens).toBe(5);
  });

  it('aborts the session when the signal is aborted', async () => {
    let rejectPrompt: ((err: Error) => void) | undefined;
    mockClient.session.prompt.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPrompt = reject;
        }),
    );
    const adapter = new OpencodeAdapter();

    const controller = new AbortController();
    const promise = adapter.execute('slow', { shared: {} }, { signal: controller.signal });

    await vi.waitFor(() => expect(mockClient.session.prompt).toHaveBeenCalled());
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

    const prompt = (mockClient.session.prompt as Mock).mock.calls[0][0];
    expect(prompt.model).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
  });

  it('passes tools as a boolean map when configured', async () => {
    const adapter = new OpencodeAdapter({ tools: ['read', 'edit'] });

    await adapter.execute('x', { shared: {} });

    const prompt = (mockClient.session.prompt as Mock).mock.calls[0][0];
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
});
