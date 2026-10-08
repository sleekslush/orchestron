import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { Conductor } from '../conductor/conductor.js';
import { FakeHarnessAdapter } from '../conductor/fake-harness.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import { NATIVE_SESSION_FILE, writeAttemptMetadata, attemptDirName, movementDirName } from '../recording/artifacts.js';
import type { Movement, Score } from '../types/score.js';
import type { SessionRecording } from '../types/adapter.js';
import type { StreamRecord } from '../store/concert-stream.js';

/**
 * Simulates the pi adapter's recording contract: raw events recorded first,
 * user.prompt synthetic, native export + metadata.json written by the
 * adapter in its finally, sessionId stamped at export time.
 */
class RecordingPiFake extends FakeHarnessAdapter {
  readonly type = 'pi';
  recordCalls: Array<{ event: unknown; meta?: { synthetic?: boolean; type?: string } }> = [];

  async execute(
    prompt: string,
    context: unknown,
    options?: { recording?: SessionRecording; movementId?: string } & Record<string, unknown>,
  ) {
    this.recordCalls.push({ event: { type: 'adapter:enter', prompt }, meta: undefined });
    const recording = options?.recording;
    if (recording) {
      recording.recordSynthetic('user.prompt', { prompt });
      recording.events.record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
      recording.events.record({ type: 'agent_end', messages: [], willRetry: false });
      // Adapter-side finalization, mirroring PiAdapter.finalizeSessionRecording.
      await recording.events.flush();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(recording.attemptDir, NATIVE_SESSION_FILE.pi),
        [
          `${JSON.stringify({ type: 'session', version: 3, id: 'pi-session-xyz', timestamp: new Date().toISOString(), cwd: '/' })}\n`,
          `${JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } })}\n`,
        ].join(''),
      );
      await writeAttemptMetadata(recording.attemptDir, {
        concertId: recording.concertId,
        movementId: recording.movementId,
        attempt: recording.attemptIndex,
        harness: 'pi',
        mode: recording.mode,
        sessionKey: recording.sessionKey,
        sessionId: recording.sessionId,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: 'completed',
        eventCount: 2,
        files: { native: NATIVE_SESSION_FILE.pi, sizeBytes: 17 },
      });
    }
    return super.execute(prompt, context as never, options);
  }
}

function score(
  program: Score['program'],
  retry: { retryOnFailure?: boolean; maxRetries?: number } = {},
  id = 'recording-test',
): Score {
  return {
    id,
    name: 'Recording Test',
    description: 'records everything',
    version: '1.0.0',
    startMovement: 'a',
    movements: [
      {
        id: 'a',
        name: 'A',
        section: 'x',
        description: 'x',
        harness: 'pi',
        prompt: 'do it',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: '__end__', on: 'success' as const }],
        retryOnFailure: retry.retryOnFailure ?? false,
        budget: retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : undefined,
      },
    ],
    program,
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

/**
 * Two-movement score for session-mode precedence tests: `a` (optionally with a
 * movement-level `reuseSession` override and a forced first-attempt retry) runs
 * first and hands off to sibling `b`, which never declares an override.
 */
function twoMovementScore(
  program: Score['program'],
  aOverride: boolean | undefined,
  aRetry = false,
): Score {
  return {
    id: 'recording-test',
    name: 'Recording Test',
    version: '1.0.0',
    startMovement: 'a',
    movements: [
      {
        id: 'a',
        name: 'A',
        section: 'x',
        harness: 'pi',
        prompt: 'do a',
        reuseSession: aOverride,
        retryOnFailure: aRetry,
        budget: aRetry ? { maxRetries: 1 } : undefined,
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: 'b', on: 'success' as const }],
      },
      {
        id: 'b',
        name: 'B',
        section: 'x',
        harness: 'pi',
        prompt: 'do b',
        goal: { description: 'done', strategy: 'llm_judge' as const },
        transitions: [{ to: '__end__', on: 'success' as const }],
      },
    ],
    program,
  };
}

describe('Conductor recording artifacts', () => {
  it('records stream envelopes, per-attempt dirs, index files, and session_traces rows', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(score({}));
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();
      expect(conductor.status).toBe('completed');

      const stream = await hall.getConcertStream()!.read(conductor.concertId);
      expect(stream.length).toBeGreaterThan(0);
      expect(stream.some((r) => r.source === 'concert' && r.type === 'movement:started')).toBe(true);
      expect(stream.some((r) => r.source === 'concert' && r.type === 'concert:completed')).toBe(true);

      // SDK records stamped with per-attempt ctx; user.prompt synthetic first.
      const sdkRecords = stream.filter((r) => r.source === 'sdk');
      expect(sdkRecords.length).toBe(3);
      expect(sdkRecords[0]).toMatchObject({
        type: 'user.prompt',
        synthetic: true,
        movementId: 'a',
        attempt: 0,
        harness: 'pi',
      });
      expect((sdkRecords[0].data as { prompt?: string }).prompt).toBe('do it');
      expect(sdkRecords[1]!.type).toBe('message_update');
      expect(sdkRecords[2]!.type).toBe('agent_end');
      for (const r of sdkRecords) {
        expect(r.concertId).toBe(conductor.concertId);
      }

      const rec = adapter.recordCalls[0]!.event as { prompt: string };
      expect(rec.prompt).toBe('do it');

      // Per-attempt artifacts: native session + adapter metadata.json.
      const attemptDir = join(tracesDir, conductor.concertId, 'movements', 'a', 'attempt-0');
      expect(existsSync(attemptDir)).toBe(true);
      expect(existsSync(join(attemptDir, 'pi-session.jsonl'))).toBe(true);
      expect(existsSync(join(attemptDir, 'metadata.json'))).toBe(true);
      const meta = await readJson<{ attempt: number; status: string; eventCount: number }>(
        join(attemptDir, 'metadata.json'),
      );
      expect(meta.attempt).toBe(0);
      expect(meta.eventCount).toBe(2);

      // Movement index: cumulative → final-* copy present and referenced.
      const movementIndex = await readJson<{
        finalAttempt: number;
        finalStatus: string;
        finalSessionFile: string;
        attempts: Array<{ attempt: number; status: string; path: string }>;
      }>(join(tracesDir, conductor.concertId, 'movements', 'a', 'index.json'));
      expect(movementIndex.finalAttempt).toBe(0);
      expect(movementIndex.finalStatus).toBe('completed');
      expect(movementIndex.finalSessionFile).toBe('final-pi-session.jsonl');
      expect(movementIndex.attempts).toHaveLength(1);
      expect(existsSync(join(tracesDir, conductor.concertId, 'movements', 'a', 'final-pi-session.jsonl'))).toBe(true);

      // Concert index references the movement artifact.
      const concertIndex = await readJson<{
        status: string;
        stream: string;
        movements: Array<{ id: string; attempts: number; finalSessionFile: string }>;
      }>(join(tracesDir, conductor.concertId, 'index.json'));
      expect(concertIndex.status).toBe('completed');
      expect(concertIndex.stream).toBe('stream.jsonl');
      expect(concertIndex.movements[0]).toMatchObject({
        id: 'a',
        attempts: 1,
        finalSessionFile: 'movements/a/final-pi-session.jsonl',
      });

      // Per-attempt session_traces row.
      const traces = await store.getSessionTracesForConcert(conductor.concertId);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        movementId: 'a',
        attemptIndex: 0,
        harness: 'pi',
        mode: 'cumulative',
        status: 'completed',
      });
      expect(traces[0].filePath).toBe('movements/a/attempt-0');
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('fresh sessions: per-attempt snapshots, no final copy, last attempt referenced', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-fresh-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(score({ reuseSession: false }));
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();
      expect(conductor.status).toBe('completed');

      const moveDir = join(tracesDir, conductor.concertId, 'movements', 'a');
      const movementIndex = await readJson<{ mode: string; finalSessionFile: string; finalAttempt: number }>(
        join(moveDir, 'index.json'),
      );
      expect(movementIndex.mode).toBe('fresh');
      expect(movementIndex.finalAttempt).toBe(0);
      expect(movementIndex.finalSessionFile).toBe('attempt-0/pi-session.jsonl');
      // No aggregation copy in fresh mode.
      expect(existsSync(join(moveDir, 'final-pi-session.jsonl'))).toBe(false);

      const traces = await store.getSessionTracesForConcert(conductor.concertId);
      expect(traces[0]!.mode).toBe('fresh');
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('retries create one attempt dir + session_traces row each', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-retry-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(score({}, { retryOnFailure: true, maxRetries: 1 }));
    const adapter = new (class extends RecordingPiFake {
      calls = 0;
      async execute(
        prompt: string,
        context: unknown,
        options?: Parameters<RecordingPiFake['execute']>[2],
      ) {
        const recording = options?.recording;
        // First attempt: record like pi does (raw events + synthetic prompt),
        // then fail AFTER recording so the attempt is logged as failed.
        if (recording && this.calls++ === 0) {
          recording.recordSynthetic('user.prompt', { prompt });
          recording.events.record({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
          recording.events.record({ type: 'agent_end', messages: [], willRetry: false });
          await recording.events.flush();
          const err = new Error('transient harness failure');
          (err as { code?: string }).code = 'HARNESS_FAILURE';
          throw err;
        }
        return super.execute(prompt, context, options);
      }
    })({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();

      const moveDir = join(tracesDir, conductor.concertId, 'movements', 'a');
      const entries = await readdir(moveDir);
      const attemptDirs = entries.filter((e) => /^attempt-\d+$/.test(e));
      expect(attemptDirs.sort()).toEqual(['attempt-0', 'attempt-1']);

      const stream = await hall.getConcertStream()!.read(conductor.concertId);
      const attempts = stream
        .filter((r) => r.source === 'sdk' && r.type === 'user.prompt')
        .map((r) => r.attempt);
      expect(attempts).toEqual([0, 1]);

      const movementIndex = await readJson<{
        finalAttempt: number;
        attempts: Array<{ attempt: number; status: string; path: string }>;
      }>(join(moveDir, 'index.json'));
      expect(movementIndex.attempts.map((a) => a.attempt)).toEqual([0, 1]);
      expect(movementIndex.attempts[0]!.status).toBe('failed');
      expect(movementIndex.attempts[1]!.status).toBe('completed');

      const traces = await store.getSessionTracesForConcert(conductor.concertId);
      expect(traces.map((t) => t.attemptIndex).sort()).toEqual([0, 1]);
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it.each([
    { program: {}, label: 'cumulative default', reuse: true },
    { program: { reuseSession: false }, label: 'fresh', reuse: false },
  ] as Array<{ program: Score['program']; label: string; reuse: boolean }>)(
    'passes the movement session key to the Musician on every attempt of a re-visited movement ($label)',
    async ({ program, reuse }) => {
      const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-sessionid-'));
      const store = new SqliteLoge(':memory:');
      const registry = new ScoreRegistry();
      // Force a retry so movement 'a' is executed twice in one concert.
      registry.register(score(program, { retryOnFailure: true, maxRetries: 1 }));
      const seen: Array<string | undefined> = [];
      const adapter = new (class extends FakeHarnessAdapter {
        calls = 0;
        async execute(
          prompt: string,
          context: unknown,
          options?: Parameters<FakeHarnessAdapter['execute']>[2],
        ) {
          seen.push(options?.sessionId);
          if (this.calls++ === 0) {
            const err = new Error('transient harness failure');
            (err as { code?: string }).code = 'HARNESS_FAILURE';
            throw err;
          }
          return super.execute(prompt, context as never, options);
        }
      })({
        defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
      });
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        tracesDir,
      });
      try {
        const conductor = await hall.createConcert('recording-test');
        await conductor.start();
        expect(conductor.status).toBe('completed');
        expect(seen).toHaveLength(2);
        if (reuse) {
          const movementKey = `${conductor.concertId}:a`;
          expect(seen).toEqual([movementKey, movementKey]);
        } else {
          expect(seen).toEqual([undefined, undefined]);
        }
      } finally {
        rmSync(tracesDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { program: {}, label: 'reuseSession default (cumulative)' },
    { program: { reuseSession: true }, label: 'reuseSession: true (cumulative)' },
    { program: { reuseSession: false }, label: 'reuseSession: false (fresh)' },
  ] as Array<{ program: Score['program']; label: string }>)(
    'pins recording semantics: per-attempt transcript always on disk, aggregated final copy only when cumulative ($label)',
    async ({ program }) => {
      const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-pin-'));
      const store = new SqliteLoge(':memory:');
      const registry = new ScoreRegistry();
      registry.register(score(program));
      const adapter = new RecordingPiFake({
        defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
      });
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        tracesDir,
      });
      try {
        const conductor = await hall.createConcert('recording-test');
        await conductor.start();
        expect(conductor.status).toBe('completed');

        const moveDir = join(tracesDir, conductor.concertId, 'movements', 'a');
        const expectedMode = program?.reuseSession === false ? 'fresh' : 'cumulative';
        const movementIndex = await readJson<{ mode: string }>(join(moveDir, 'index.json'));
        expect(movementIndex.mode).toBe(expectedMode);

        // Both modes record the per-attempt native transcript to disk.
        expect(existsSync(join(moveDir, 'attempt-0', 'pi-session.jsonl'))).toBe(true);

        // Only cumulative additionally produces the aggregated final copy.
        const finalCopy = join(moveDir, 'final-pi-session.jsonl');
        if (expectedMode === 'cumulative') {
          expect(existsSync(finalCopy)).toBe(true);
        } else {
          expect(existsSync(finalCopy)).toBe(false);
        }
      } finally {
        rmSync(tracesDir, { recursive: true, force: true });
      }
    });

  it('legacy persistSession alias still works, warns, and yields when reuseSession is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-alias-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    // Legacy key only: honored as a deprecated alias.
    registry.register(score({ persistSession: false }));
    // New key wins when both are set (legacy alias ignored).
    registry.register(score({ reuseSession: false, persistSession: true }, {}, 'preferred-win'));
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const legacy = await hall.createConcert('recording-test');
      await legacy.start();
      const legacyIndex = await readJson<{ mode: string }>(
        join(tracesDir, legacy.concertId, 'movements', 'a', 'index.json'),
      );
      expect(legacyIndex.mode).toBe('fresh');

      const preferred = await hall.createConcert('preferred-win');
      await preferred.start();
      const preferredIndex = await readJson<{ mode: string }>(
        join(tracesDir, preferred.concertId, 'movements', 'a', 'index.json'),
      );
      expect(preferredIndex.mode).toBe('fresh'); // reuseSession: false wins

      const deprecationWarnings = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((msg) => msg.includes('persistSession') && msg.includes('deprecated'));
      expect(deprecationWarnings.length).toBe(2);
      expect(deprecationWarnings[0]).toContain('rename it to \'reuseSession\'');
      expect(deprecationWarnings[1]).toContain('reuseSession takes precedence');
    } finally {
      warn.mockRestore();
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('record events survive non-serializable payloads (recorded, stringify skipped)', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-cyclic-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(score({}));
    const cyclicAdapter = new (class extends RecordingPiFake {
      async execute(prompt: string, context: unknown, options?: Parameters<RecordingPiFake['execute']>[2]) {
        const recording = options?.recording;
        if (recording) {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          recording.events.record(cyclic);
        }
        return super.execute(prompt, context, options);
      }
    })({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', cyclicAdapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();
      expect(conductor.status).toBe('completed');

      const stream = await hall.getConcertStream()!.read(conductor.concertId);
      const sdkRecord: StreamRecord | undefined = stream.find((r) => r.source === 'sdk' && r.type === 'sdk.event');
      expect(sdkRecord).toBeUndefined(); // cyclic record could not be serialized → skipped
      // But the healthy records still landed.
      const prompts = stream.filter((r) => r.source === 'sdk' && r.type === 'user.prompt');
      expect(prompts).toHaveLength(1);
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'movement override false on a cumulative-default score',
      program: {} as Score['program'],
      override: false,
      expectedA: 'fresh' as const,
      expectedB: 'cumulative' as const,
    },
    {
      label: 'movement override true on a fresh-default score',
      program: { reuseSession: false } as Score['program'],
      override: true,
      expectedA: 'cumulative' as const,
      expectedB: 'fresh' as const,
    },
  ])(
    'resolves the effective session mode per movement ($label)',
    async ({ program, override, expectedA, expectedB }) => {
      const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-override-'));
      const store = new SqliteLoge(':memory:');
      const registry = new ScoreRegistry();
      registry.register(twoMovementScore(program, override, true));
      const seen: Array<{ movementId?: string; sessionId?: string }> = [];
      const adapter = new (class extends RecordingPiFake {
        calls = 0;
        async execute(
          prompt: string,
          context: unknown,
          options?: Parameters<RecordingPiFake['execute']>[2],
        ) {
          seen.push({ movementId: options?.movementId, sessionId: options?.sessionId as string | undefined });
          // Force movement 'a' to be re-visited, recording its first attempt
          // before failing so the retry exercises the cumulative path.
          if (options?.movementId === 'a' && this.calls++ === 0) {
            const recording = options?.recording;
            if (recording) {
              recording.recordSynthetic('user.prompt', { prompt });
              await recording.events.flush();
              const { writeFile } = await import('node:fs/promises');
              await writeFile(
                join(recording.attemptDir, NATIVE_SESSION_FILE.pi),
                '{"type":"session","version":3}\n',
              );
            }
            const err = new Error('transient harness failure');
            (err as { code?: string }).code = 'HARNESS_FAILURE';
            throw err;
          }
          return super.execute(prompt, context, options);
        }
      })({
        defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
      });
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        tracesDir,
      });
      try {
        const conductor = await hall.createConcert('recording-test');
        await conductor.start();
        expect(conductor.status).toBe('completed');
        const cid = conductor.concertId;

        // Session identifier: only the overriding movement diverges from the
        // score default; the sibling keeps it. Movement 'a' is re-visited.
        const aSessions = seen
          .filter((s) => s.movementId === 'a')
          .map((s) => s.sessionId);
        const bSessions = seen
          .filter((s) => s.movementId === 'b')
          .map((s) => s.sessionId);
        const expectedAKey = expectedA === 'cumulative' ? `${cid}:a` : undefined;
        const expectedBKey = expectedB === 'cumulative' ? `${cid}:b` : undefined;
        expect(aSessions).toEqual([expectedAKey, expectedAKey]);
        expect(bSessions).toEqual([expectedBKey]);

        // Movement index records the effective mode.
        const aIndex = await readJson<{ mode: string; finalSessionFile: string }>(
          join(tracesDir, cid, 'movements', 'a', 'index.json'),
        );
        expect(aIndex.mode).toBe(expectedA);
        const bIndex = await readJson<{ mode: string }>(
          join(tracesDir, cid, 'movements', 'b', 'index.json'),
        );
        expect(bIndex.mode).toBe(expectedB);

        // Cumulative movements aggregate a final copy; fresh ones do not.
        expect(existsSync(join(tracesDir, cid, 'movements', 'a', 'final-pi-session.jsonl'))).toBe(
          expectedA === 'cumulative',
        );
        expect(existsSync(join(tracesDir, cid, 'movements', 'b', 'final-pi-session.jsonl'))).toBe(
          expectedB === 'cumulative',
        );

        // Concert index reports the effective per-movement mode.
        const concertIndex = await readJson<{
          movements: Array<{ id: string; mode: string }>;
        }>(join(tracesDir, cid, 'index.json'));
        expect(concertIndex.movements.find((m) => m.id === 'a')?.mode).toBe(expectedA);
        expect(concertIndex.movements.find((m) => m.id === 'b')?.mode).toBe(expectedB);

        // Per-attempt session_traces rows report the effective mode.
        const traces = await store.getSessionTracesForConcert(cid);
        expect(traces.filter((t) => t.movementId === 'a').map((t) => t.mode)).toEqual([
          expectedA,
          expectedA,
        ]);
        expect(traces.filter((t) => t.movementId === 'b').map((t) => t.mode)).toEqual([
          expectedB,
        ]);
      } finally {
        rmSync(tracesDir, { recursive: true, force: true });
      }
    },
  );

  it('movement override wins while the score-level persistSession warning still fires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-alias-override-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    // Legacy score-level alias resolves to cumulative; the movement forces fresh.
    registry.register(twoMovementScore({ persistSession: true }, false));
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();
      expect(conductor.status).toBe('completed');

      const warnings = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((msg) => msg.includes('persistSession') && msg.includes('deprecated'));
      expect(warnings).toHaveLength(1);

      // The override determines movement 'a'; sibling 'b' inherits the alias value.
      const aIndex = await readJson<{ mode: string }>(
        join(tracesDir, conductor.concertId, 'movements', 'a', 'index.json'),
      );
      expect(aIndex.mode).toBe('fresh');
      const bIndex = await readJson<{ mode: string }>(
        join(tracesDir, conductor.concertId, 'movements', 'b', 'index.json'),
      );
      expect(bIndex.mode).toBe('cumulative');
    } finally {
      warn.mockRestore();
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('ignores an unrecognized movement-level persistSession key', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-movement-alias-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    const scoreWithMovementAlias = twoMovementScore({ reuseSession: false }, undefined);
    // Not a recognized Movement field: it must have no effect.
    (scoreWithMovementAlias.movements[0] as Movement & { persistSession?: boolean }).persistSession =
      true;
    registry.register(scoreWithMovementAlias);
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('recording-test');
      await conductor.start();
      const aIndex = await readJson<{ mode: string }>(
        join(tracesDir, conductor.concertId, 'movements', 'a', 'index.json'),
      );
      // Movement inherits the fresh score default; the bogus alias is inert.
      expect(aIndex.mode).toBe('fresh');
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('subscore movements create no parent session and the movement-level field is inert', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-subscore-mode-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register({
      id: 'sub-parent',
      name: 'Sub Parent',
      version: '1.0.0',
      startMovement: 'p',
      movements: [
        {
          id: 'p',
          name: 'P',
          section: 'x',
          // The parent movement-level field must not affect the child score.
          reuseSession: false,
          subscore: { scoreId: 'sub-child', contextMapping: {} },
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: '__end__', on: 'success' as const }],
        },
      ],
      program: {},
    });
    registry.register({
      id: 'sub-child',
      name: 'Sub Child',
      version: '1.0.0',
      startMovement: 'c',
      movements: [
        {
          id: 'c',
          name: 'C',
          section: 'x',
          harness: 'pi',
          prompt: 'do c',
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: '__end__', on: 'success' as const }],
        },
      ],
      program: {},
    });
    const seen: Array<{ movementId?: string; sessionId?: string }> = [];
    const adapter = new (class extends FakeHarnessAdapter {
      async execute(
        prompt: string,
        context: unknown,
        options?: Parameters<FakeHarnessAdapter['execute']>[2],
      ) {
        seen.push({ movementId: options?.movementId, sessionId: options?.sessionId as string | undefined });
        return super.execute(prompt, context as never, options);
      }
    })({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const conductor = await hall.createConcert('sub-parent');
      await conductor.start();
      expect(conductor.status).toBe('completed');

      // Only the child movement executed; the parent's subscore movement never
      // resolved a session. The child score governs nested session behavior, so
      // the parent movement-level `reuseSession: false` is inert here and the
      // child keeps its cumulative default.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.movementId).toBe('c');
      expect(seen[0]!.sessionId).toMatch(/:c$/);
      expect(seen[0]!.sessionId).not.toBe(`${conductor.concertId}:p`);
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });

  it('history-only never-executed movements fall back to the score-level mode in the concert index', async () => {
    const tracesDir = mkdtempSync(join(tmpdir(), 'orchestron-rec-recover-mode-'));
    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    // Score default is fresh; the crashed movement overrides to cumulative. It
    // is pushed to history during crash recovery without ever executing, so the
    // concert index must fall back to the score-level `fresh`, never the
    // movement override.
    registry.register({
      id: 'recovery-recording',
      name: 'Recovery Recording',
      version: '1.0.0',
      startMovement: 'a',
      movements: [
        {
          id: 'a',
          name: 'A',
          section: 'x',
          harness: 'pi',
          prompt: 'do a',
          reuseSession: true,
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [
            { to: 'b', on: 'success' as const },
            { to: 'b', on: 'failure' as const },
          ],
        },
        {
          id: 'b',
          name: 'B',
          section: 'x',
          harness: 'pi',
          prompt: 'do b',
          goal: { description: 'done', strategy: 'llm_judge' as const },
          transitions: [{ to: '__end__', on: 'success' as const }],
        },
      ],
      program: { reuseSession: false },
    });
    const adapter = new RecordingPiFake({
      defaultResponse: { output: 'o', summary: 's', usage: { spend: 0, tokens: 1 } },
    });
    const hall = new ConcertHall({
      store,
      scoreRegistry: registry,
      adapters: new Map([['pi', adapter as unknown as FakeHarnessAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      tracesDir,
    });
    try {
      const created = await hall.createConcert('recovery-recording');
      const concertId = created.concertId;
      // Simulate a crash mid-'a': the persisted concert points at the crashed
      // movement, which is recovered without a movement-mode-map entry.
      await store.updateConcert({ id: concertId, status: 'running', currentMovement: 'a' });
      const stored = await store.getConcert(concertId);
      const recovered = new Conductor(
        stored!,
        registry.get('recovery-recording')!,
        store,
        hall,
        new Map([['pi', adapter]]),
        new FakeEvaluator({ alwaysSucceed: true }),
        tracesDir,
      );
      await recovered.recover();
      expect(recovered.status).toBe('completed');

      const concertIndex = await readJson<{
        movements: Array<{ id: string; mode: string }>;
      }>(join(tracesDir, concertId, 'index.json'));
      // 'a' never executed: score-level fallback, not the movement-level override.
      expect(concertIndex.movements.find((m) => m.id === 'a')?.mode).toBe('fresh');
      // 'b' executed under the fresh score default.
      expect(concertIndex.movements.find((m) => m.id === 'b')?.mode).toBe('fresh');
    } finally {
      rmSync(tracesDir, { recursive: true, force: true });
    }
  });
});