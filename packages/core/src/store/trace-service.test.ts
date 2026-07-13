import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
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

  it('readTurns skips malformed JSON lines', async () => {
    const concertId = 'c1';
    const filePath = join(tracesDir, concertId, 't1.jsonl');
    await mkdir(join(tracesDir, concertId), { recursive: true });
    await writeFile(
      filePath,
      '{"type":"prompt","content":"hi","timestamp":"2024-01-01T00:00:00.000Z"}\nthis is not json\n{"type":"text_delta","delta":"ok","timestamp":"2024-01-01T00:00:01.000Z"}\n',
    );

    const trace = {
      id: 't1',
      concertId,
      movementId: 'm1',
      sessionId: 's1',
      filePath: join(concertId, 't1.jsonl'),
      startedAt: new Date(),
      eventCount: 3,
      status: 'completed' as const,
      format: 'orchestron-trace' as const,
    };

    const events = await service.readTurns(trace);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('prompt');
    expect(events[1].type).toBe('text_delta');
  });
});
