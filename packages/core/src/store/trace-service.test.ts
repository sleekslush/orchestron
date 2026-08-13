import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceService } from './trace-service.js';
import { SqliteLoge } from './sqlite-loge.js';

describe('TraceService', () => {
  let tracesDir: string;
  let store: SqliteLoge;
  let service: TraceService;

  beforeEach(async () => {
    tracesDir = join(tmpdir(), `orchestron-trace-test-${Date.now()}`);
    await mkdir(tracesDir, { recursive: true });
    store = new SqliteLoge(':memory:');
    service = new TraceService(tracesDir, store);
  });

  afterEach(async () => {
    store.close();
    await rm(tracesDir, { recursive: true, force: true });
  });

  it('recordAttempt stores a per-attempt session trace row', async () => {
    const id = await service.recordAttempt({
      concertId: 'c1',
      movementId: 'm1',
      sessionKey: 'c1:m1',
      sessionId: 'pi-sess',
      attemptIndex: 0,
      harness: 'pi',
      mode: 'cumulative',
      filePath: 'movements/m1/attempt-0',
      status: 'completed',
      eventCount: 3,
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      endedAt: new Date('2024-01-01T00:00:01.000Z'),
    });

    expect(id).toBeDefined();
    const row = await store.getSessionTraceForMovement('c1', 'm1');
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      concertId: 'c1',
      movementId: 'm1',
      sessionId: 'pi-sess',
      sessionKey: 'c1:m1',
      attemptIndex: 0,
      harness: 'pi',
      mode: 'cumulative',
      filePath: 'movements/m1/attempt-0',
      eventCount: 3,
      status: 'completed',
      format: 'pi-jsonl',
    });
  });
});
