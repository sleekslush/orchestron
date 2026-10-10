import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLoge } from '../store/sqlite-loge.js';
import { ScoreRegistry } from '../registry/score-registry.js';
import { ConcertHall } from '../hall/concert-hall.js';
import { FakeEvaluator } from '../evaluator/fake-evaluator.js';
import type { Movement, Score } from '../types/score.js';

const NODE = process.execPath;

function makeHall(score: Score, tracesDir: string): { hall: ConcertHall; store: SqliteLoge } {
  const store = new SqliteLoge(':memory:');
  const registry = new ScoreRegistry();
  registry.register(score);
  const hall = new ConcertHall({
    store,
    scoreRegistry: registry,
    adapters: new Map(),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    tracesDir,
  });
  return { hall, store };
}

/**
 * Build the plan §3.4 branch-preparation chain as run movements. `paths`
 * parameterizes the filesystem stand-ins for git/gh state so the chain is
 * deterministic and portable:
 *  - `branchMarker` present  => "branch exists" (check exits 0)
 *  - `createFailMarker` present => "create failed" (create exits 1)
 *  - `capturePath` records the create argv or the reuse decision
 */
function branchScore(paths: {
  branchMarker: string;
  createFailMarker: string;
  capturePath: string;
}): Score {
  const { branchMarker, createFailMarker, capturePath } = paths;
  const movements: Movement[] = [
    {
      id: 'resolve_base',
      name: 'Resolve base',
      section: 'setup',
      type: 'run',
      command: [NODE, '-e', 'process.stdout.write(JSON.stringify({ defaultBranchRef: { name: "main" } }))'],
      output: { mode: 'structured' },
      transitions: [
        { to: 'fetch', on: 'success' },
        { to: 'fail_cleanup', on: 'failure' },
      ],
    },
    {
      id: 'fetch',
      name: 'Fetch origin',
      section: 'setup',
      type: 'run',
      command: [NODE, '-e', 'process.exit(0)'],
      transitions: [
        { to: 'check_branch', on: 'success' },
        { to: 'fail_cleanup', on: 'failure' },
      ],
    },
    {
      id: 'check_branch',
      name: 'Check branch',
      section: 'setup',
      type: 'run',
      command: [
        NODE,
        '-e',
        `const fs=require('fs');process.exit(fs.existsSync(${JSON.stringify(branchMarker)})?0:1)`,
      ],
      outcomes: { 0: 'success', 1: 'rejection', default: 'failure' },
      transitions: [
        { to: 'reuse_branch', on: 'success' },
        { to: 'create_branch', on: 'rejection' },
        { to: 'fail_cleanup', on: 'failure' },
      ],
    },
    {
      id: 'create_branch',
      name: 'Create branch',
      section: 'setup',
      type: 'run',
      command: [
        NODE,
        '-e',
        `const fs=require('fs');if(fs.existsSync(${JSON.stringify(createFailMarker)}))process.exit(1);fs.writeFileSync(${JSON.stringify(capturePath)}, process.argv[1] ?? '')`,
        'origin/{{context.previousOutputs.resolve_base.defaultBranchRef.name}}',
      ],
      outcomes: { 0: 'success', default: 'failure' },
      transitions: [
        { to: 'implement', on: 'success' },
        { to: 'fail_cleanup', on: 'failure' },
      ],
    },
    {
      id: 'reuse_branch',
      name: 'Reuse branch',
      section: 'setup',
      type: 'run',
      command: [
        NODE,
        '-e',
        `const fs=require('fs');fs.writeFileSync(${JSON.stringify(capturePath)}, 'reuse')`,
      ],
      outcomes: { 0: 'success', default: 'failure' },
      transitions: [
        { to: 'implement', on: 'success' },
        { to: 'fail_cleanup', on: 'failure' },
      ],
    },
    {
      id: 'implement',
      name: 'Implement',
      section: 'execution',
      type: 'run',
      command: [NODE, '-e', 'process.exit(0)'],
      transitions: [{ to: '__end__', on: 'success' }],
    },
    {
      id: 'fail_cleanup',
      name: 'Fail cleanup',
      section: 'cleanup',
      type: 'run',
      command: [NODE, '-e', 'process.exit(0)'],
      transitions: [{ to: '__fail__', on: 'any' }],
    },
  ];
  return {
    id: 'branch-prep',
    name: 'Branch Prep',
    version: '1.0.0',
    startMovement: 'resolve_base',
    movements,
    program: {},
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'orchestron-branch-'));
}

describe('branch-preparation chain', () => {
  it('passes the structured base leaf into the create argv with no trailing newline', async () => {
    const dir = tmp();
    const capturePath = join(dir, 'capture');
    const score = branchScore({
      branchMarker: join(dir, 'branch-exists'),
      createFailMarker: join(dir, 'create-fails'),
      capturePath,
    });
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('branch-prep');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const ids = (await store.getMovementHistory(conductor.concertId)).map((h) => h.movementId);
    expect(ids).toContain('create_branch');
    expect(ids).toContain('implement');
    expect(ids).not.toContain('reuse_branch');
    expect(ids).not.toContain('fail_cleanup');
    // Exactly `origin/` + the parsed leaf, no trailing newline from stdout.
    expect(readFileSync(capturePath, 'utf-8')).toBe('origin/main');
    expect(existsSync(join(dir, 'branch-exists'))).toBe(false);
  });

  it('routes an existing branch (check exit 0) to reuse', async () => {
    const dir = tmp();
    const capturePath = join(dir, 'capture');
    const branchMarker = join(dir, 'branch-exists');
    writeFileSync(branchMarker, '1');
    const score = branchScore({
      branchMarker,
      createFailMarker: join(dir, 'create-fails'),
      capturePath,
    });
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('branch-prep');
    await conductor.start();

    expect(conductor.status).toBe('completed');
    const ids = (await store.getMovementHistory(conductor.concertId)).map((h) => h.movementId);
    expect(ids).toContain('reuse_branch');
    expect(ids).toContain('implement');
    expect(ids).not.toContain('create_branch');
    expect(readFileSync(capturePath, 'utf-8')).toBe('reuse');
  });

  it('routes an absent branch (check exit 1) to create', async () => {
    const dir = tmp();
    const capturePath = join(dir, 'capture');
    const score = branchScore({
      branchMarker: join(dir, 'branch-exists'),
      createFailMarker: join(dir, 'create-fails'),
      capturePath,
    });
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('branch-prep');
    await conductor.start();

    const ids = (await store.getMovementHistory(conductor.concertId)).map((h) => h.movementId);
    expect(ids).toContain('create_branch');
    expect(ids).not.toContain('reuse_branch');
  });

  it('routes a create failure to fail_cleanup', async () => {
    const dir = tmp();
    const createFailMarker = join(dir, 'create-fails');
    writeFileSync(createFailMarker, '1');
    const score = branchScore({
      branchMarker: join(dir, 'branch-exists'),
      createFailMarker,
      capturePath: join(dir, 'capture'),
    });
    const { hall, store } = makeHall(score, dir);
    const conductor = await hall.createConcert('branch-prep');
    await conductor.start();

    expect(conductor.status).toBe('failed');
    const ids = (await store.getMovementHistory(conductor.concertId)).map((h) => h.movementId);
    expect(ids).toContain('create_branch');
    expect(ids).toContain('fail_cleanup');
    expect(ids).not.toContain('implement');
  });
});
