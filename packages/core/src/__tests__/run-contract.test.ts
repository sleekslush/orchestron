import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScoreRegistry } from '../registry/score-registry.js';
import { PromptBuilder } from '../conductor/prompt-builder.js';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { createSqliteDb } from '../store/sqlite-driver.js';
import { resolveRunOutcome } from '../conductor/run-outcome.js';
import type { Movement, Score } from '../types/score.js';
import type { MovementRecord } from '../types/concert.js';

function baseScore(movements: Movement[]): Score {
  return {
    id: 's',
    name: 'S',
    version: '1.0.0',
    startMovement: movements[0].id,
    movements,
    program: {},
  };
}

function runMovement(overrides: Partial<Movement> = {}): Movement {
  return {
    id: 'run',
    name: 'Run',
    section: 'default',
    type: 'run',
    command: ['echo', 'hi'],
    transitions: [{ to: '__end__', on: 'success' }],
    ...overrides,
  };
}

describe('run movement registry validation', () => {
  it('loads and validates the deterministic-claim example fixture', () => {
    const registry = new ScoreRegistry();
    const path = fileURLToPath(
      new URL('../../../../examples/deterministic-claim.score.yaml', import.meta.url),
    );
    expect(() => registry.loadFrom(path)).not.toThrow();
    const score = registry.get('deterministic-claim');
    const ids = score.movements.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['claim', 'check_branch', 'create_branch', 'reuse_branch', 'fail_cleanup']),
    );
    expect(score.movements.every((m) => m.type === 'run')).toBe(true);
    expect(score.movements.every((m) => m.goal === undefined)).toBe(true);
    const check = score.movements.find((m) => m.id === 'check_branch')!;
    expect(check.outcomes).toEqual({ 0: 'success', 1: 'rejection', default: 'failure' });
  });

  it('accepts a well-formed run movement', () => {
    const registry = new ScoreRegistry();
    expect(() => registry.register(baseScore([runMovement()]))).not.toThrow();
  });

  it('requires a non-empty command array', () => {
    const registry = new ScoreRegistry();
    expect(() => registry.register(baseScore([runMovement({ command: [] })]))).toThrow(
      "must have a non-empty 'command' array",
    );
    expect(() => registry.register(baseScore([runMovement({ command: undefined })]))).toThrow(
      "must have a non-empty 'command' array",
    );
  });

  it('rejects empty command elements', () => {
    const registry = new ScoreRegistry();
    expect(() => registry.register(baseScore([runMovement({ command: ['echo', '  '] })]))).toThrow(
      'command[1] must be a non-empty string',
    );
  });

  it('rejects harness-only fields on a run movement', () => {
    const fields: Array<Partial<Movement>> = [
      { goal: { description: 'x', strategy: 'llm_judge' } },
      { harness: 'pi' },
      { model: 'gpt' },
      { provider: 'openai' },
      { skills: ['/abs'] },
      { retryOnRejection: true },
      { prompt: 'do it' },
      { subscore: { scoreId: 'child', contextMapping: {} } },
    ];
    for (const field of fields) {
      const registry = new ScoreRegistry();
      const key = Object.keys(field)[0];
      expect(() => registry.register(baseScore([runMovement(field)]))).toThrow(
        `run movement 'run' cannot have '${key}'`,
      );
    }
  });

  it('validates the outcomes shape', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(baseScore([runMovement({ outcomes: { nope: 'success' } })])),
    ).toThrow("outcomes key 'nope' must be a numeric exit code or 'default'");
    expect(() =>
      registry.register(baseScore([runMovement({ outcomes: { 0: 'maybe' as never } })])),
    ).toThrow("outcomes['0'] must be 'success', 'failure', or 'rejection'");
  });

  it('requires a goal and rejects run-only fields on a harness movement', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(
        baseScore([
          {
            id: 'h',
            name: 'H',
            section: 'default',
            prompt: 'x',
            transitions: [{ to: '__end__', on: 'success' }],
          },
        ]),
      ),
    ).toThrow('must have a goal');

    expect(() =>
      registry.register(
        baseScore([
          {
            id: 'h',
            name: 'H',
            section: 'default',
            harness: 'pi',
            prompt: 'x',
            command: ['echo'],
            goal: { description: 'x', strategy: 'llm_judge' },
            transitions: [{ to: '__end__', on: 'success' }],
          },
        ]),
      ),
    ).toThrow("is a harness movement and cannot have 'command'");
  });

  it('rejects an unknown movement type', () => {
    const registry = new ScoreRegistry();
    expect(() =>
      registry.register(baseScore([runMovement({ type: 'bogus' as never })])),
    ).toThrow("has invalid type 'bogus'");
  });
});

describe('resolveRunOutcome', () => {
  it('uses explicit numeric keys, then default, then 0 -> success', () => {
    expect(resolveRunOutcome({ 0: 'success', 3: 'rejection', default: 'failure' }, 3)).toBe(
      'rejection',
    );
    expect(resolveRunOutcome({ 0: 'success', 3: 'rejection', default: 'failure' }, 7)).toBe(
      'failure',
    );
    expect(resolveRunOutcome(undefined, 0)).toBe('success');
    expect(resolveRunOutcome(undefined, 9)).toBe('failure');
    expect(resolveRunOutcome({ default: 'rejection' }, 9)).toBe('rejection');
  });
});

describe('run output template normalization', () => {
  function record(kind: 'run' | 'harness' | undefined, output: string): MovementRecord {
    return {
      movementId: 'm',
      movementName: 'M',
      status: 'completed',
      output,
      summary: '',
      goalEvaluation: { achieved: true, confidence: 1, summary: '' },
      usage: {},
      durationMs: 0,
      startedAt: new Date(),
      kind,
    };
  }

  it('trims exactly one trailing line terminator from a run record', () => {
    const pb = new PromptBuilder();
    const map = new Map([['m', record('run', 'main\n')]]);
    expect(pb.resolveTemplate('{{context.previousOutputs.m}}', map, {})).toBe('main');
  });

  it('preserves interior newlines and leading whitespace', () => {
    const pb = new PromptBuilder();
    const map = new Map([['m', record('run', '  head\nmid\n\n')]]);
    expect(pb.resolveTemplate('{{context.previousOutputs.m}}', map, {})).toBe('  head\nmid\n');
  });

  it('leaves harness output untouched', () => {
    const pb = new PromptBuilder();
    const map = new Map([['m', record(undefined, 'answer\n')]]);
    expect(pb.resolveTemplate('{{context.previousOutputs.m}}', map, {})).toBe('answer\n');
  });

  it('leaves structured accessors unaffected by trailing newlines', () => {
    const pb = new PromptBuilder();
    const r = record('run', '{"branch":"main"}\n');
    r.structured = { branch: 'main' };
    const map = new Map([['m', r]]);
    expect(pb.resolveTemplate('{{context.previousOutputs.m.branch}}', map, {})).toBe('main');
  });
});

describe('run movement persistence', () => {
  const stores: SqliteLoge[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  it('round-trips exitCode and kind', async () => {
    const store = new SqliteLoge(':memory:');
    stores.push(store);
    await store.appendMovement('c1', {
      movementId: 'm1',
      movementName: 'M1',
      status: 'completed',
      output: 'out',
      summary: 'ran',
      goalEvaluation: { achieved: true, confidence: 1, summary: '' },
      usage: { spend: 0, spendSource: 'measured' },
      durationMs: 1,
      startedAt: new Date(),
      completedAt: new Date(),
      exitCode: 0,
      kind: 'run',
    });
    const history = await store.getMovementHistory('c1');
    expect(history[0].exitCode).toBe(0);
    expect(history[0].kind).toBe('run');
  });

  it('migrates an older schema without exit_code/kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestron-migrate-'));
    const path = join(dir, 'store.db');
    const legacy = createSqliteDb(path);
    legacy.exec(`
      CREATE TABLE movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concert_id TEXT NOT NULL,
        movement_id TEXT NOT NULL,
        movement_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '',
        structured TEXT,
        summary TEXT NOT NULL DEFAULT '',
        goal_evaluation TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
    `);
    legacy.close();

    const store = new SqliteLoge(path);
    stores.push(store);
    await store.appendMovement('c1', {
      movementId: 'm1',
      movementName: 'M1',
      status: 'completed',
      output: 'out',
      summary: 'ran',
      goalEvaluation: { achieved: true, confidence: 1, summary: '' },
      usage: { spend: 0, spendSource: 'measured' },
      durationMs: 1,
      startedAt: new Date(),
      completedAt: new Date(),
      exitCode: 3,
      kind: 'run',
    });
    const history = await store.getMovementHistory('c1');
    expect(history[0].exitCode).toBe(3);
    expect(history[0].kind).toBe('run');
  });
});
