import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHarnessAdapter, FakeEvaluator } from '@orchestron/core';
import type { Score, HarnessAdapter, HarnessResponse, ConcertContext, OutputConfig } from '@orchestron/core';
import { createOrchestron } from '../orchestron.js';
import { startCommandHandler } from '../commands/start.js';
import { pauseCommandHandler, resumeCommandHandler } from '../commands/lifecycle.js';
import { statusCommandHandler } from '../commands/status.js';
import { listCommandHandler } from '../commands/list.js';
import { scoresCommandHandler } from '../commands/scores.js';

const simpleScore: Score = {
  id: 'cli-test',
  name: 'CLI Test Score',
  version: '1.0.0',
  startMovement: 'step1',
  movements: [
    {
      id: 'step1',
      name: 'Step 1',
      section: 'test',
      harness: 'fake',
      prompt: 'Do step 1 for {{context.task}}',
      goal: { description: 'Step 1 done', strategy: 'llm_judge' },
      transitions: [{ to: '__end__', on: 'success' }],
    },
  ],
  program: {},
};

function makeTempDir(): string {
  const dir = join(tmpdir(), `orchestron-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScore(dir: string, score: Score): void {
  const yaml = toYaml(score);
  writeFileSync(join(dir, `${score.id}.score.yaml`), yaml);
}

function toYaml(score: Score): string {
  const movementsYaml = score.movements
    .map(
      (m) => `  - id: ${m.id}
    name: ${m.name}
    section: ${m.section}${m.harness ? `\n    harness: ${m.harness}` : ''}
    prompt: ${m.prompt}
    goal:
      description: ${m.goal.description}
      strategy: ${m.goal.strategy}
    transitions:
${m.transitions.map((t) => `      - to: ${t.to}\n        on: ${t.on}`).join('\n')}`,
    )
    .join('\n');

  return `id: ${score.id}
name: ${score.name}
version: ${score.version}
startMovement: ${score.startMovement}
movements:
${movementsYaml}
program: {}
`;
}

async function createTestOrchestron(dir: string) {
  const storePath = join(dir, 'store.db');
  const scoresDir = join(dir, 'scores');
  mkdirSync(scoresDir, { recursive: true });
  writeScore(scoresDir, simpleScore);

  const adapter = new FakeHarnessAdapter({
    defaultResponse: {
      output: 'Fake output',
      summary: 'Done',
      usage: { spend: 5, tokens: 50 },
    },
  });

  return createOrchestron({
    storePath,
    scoresDirs: [scoresDir],
    adapters: new Map([['fake', adapter]]),
    evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    defaultHarness: 'fake',
  });
}

describe('CLI commands', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a concert and returns completed status', async () => {
    const orchestron = await createTestOrchestron(dir);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await startCommandHandler(orchestron, 'cli-test', { task: 'hello' }, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('Status:  completed'))).toBe(true);
    expect(logs.some((l) => l.includes('Score:   cli-test'))).toBe(true);
  });

  it('lists concerts', async () => {
    const orchestron = await createTestOrchestron(dir);
    await startCommandHandler(orchestron, 'cli-test', {}, false);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await listCommandHandler(orchestron, {}, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('cli-test'))).toBe(true);
  });

  it('shows status for a specific concert', async () => {
    const orchestron = await createTestOrchestron(dir);
    await startCommandHandler(orchestron, 'cli-test', {}, false);

    const concerts = await orchestron.store.listConcerts();
    const concertId = concerts[0].id;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await statusCommandHandler(orchestron, concertId, false, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes(`Concert: ${concertId}`))).toBe(true);
  });

  it('shows detailed movement information with --verbose', async () => {
    const orchestron = await createTestOrchestron(dir);
    await startCommandHandler(orchestron, 'cli-test', { task: 'hello' }, false);

    const concerts = await orchestron.store.listConcerts();
    const concertId = concerts[0].id;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await statusCommandHandler(orchestron, concertId, false, true);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes(`Concert: ${concertId}`))).toBe(true);
    expect(logs.some((l) => l.includes('Goal:'))).toBe(true);
  });

  it('shows system status when no concert id is given', async () => {
    const orchestron = await createTestOrchestron(dir);
    await startCommandHandler(orchestron, 'cli-test', {}, false);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await statusCommandHandler(orchestron, undefined, false, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('System Status'))).toBe(true);
  });

  it('lists scores', async () => {
    const orchestron = await createTestOrchestron(dir);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await scoresCommandHandler(orchestron, false, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('cli-test'))).toBe(true);
  });

  it('validates scores', async () => {
    const orchestron = await createTestOrchestron(dir);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await scoresCommandHandler(orchestron, true, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('All scores are valid.'))).toBe(true);
  });

  it('pauses and resumes a running concert', async () => {
    const twoMovementScore: Score = {
      id: 'pause-test',
      name: 'Pause Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'test',
          harness: 'fake',
          prompt: 'Do step 1',
          goal: { description: 'Step 1 done', strategy: 'llm_judge' },
          transitions: [{ to: 'step2', on: 'success' }],
        },
        {
          id: 'step2',
          name: 'Step 2',
          section: 'test',
          harness: 'fake',
          prompt: 'Do step 2',
          goal: { description: 'Step 2 done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };

    const scoresDir = join(dir, 'scores');
    mkdirSync(scoresDir, { recursive: true });
    writeScore(scoresDir, twoMovementScore);

    let releaseStep2: (() => void) | undefined;
    const pausableAdapter: HarnessAdapter = {
      type: 'fake',
      async execute(
        _prompt: string,
        _context: ConcertContext,
        options?: { signal?: AbortSignal; output?: OutputConfig; movementId?: string },
      ): Promise<HarnessResponse> {
        if (options?.movementId === 'step2') {
          await new Promise<void>((resolve) => {
            releaseStep2 = resolve;
          });
        }
        return { output: 'ok', summary: 'ok', usage: { spend: 1, tokens: 1 } };
      },
    };

    const storePath = join(dir, 'pause-store.db');
    const testOrchestron = await createOrchestron({
      storePath,
      scoresDirs: [scoresDir],
      adapters: new Map([['fake', pausableAdapter]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
    });

    const conductor = await testOrchestron.hall.createConcert('pause-test', {
      initialContext: {},
      triggeredBy: 'cli',
    });

    const runPromise = conductor.start();

    // Wait until the second movement is in progress.
    while ((await conductor.getState()).currentMovement !== 'step2') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await pauseCommandHandler(testOrchestron, conductor.concertId, false);

    // Allow the adapter to finish; the conductor should remain paused.
    releaseStep2!();

    // Poll until the conductor has observed the pause.
    for (let i = 0; i < 50; i++) {
      const state = await conductor.getState();
      if (state.status === 'paused') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect((await conductor.getState()).status).toBe('paused');

    await resumeCommandHandler(testOrchestron, conductor.concertId, false);
    await runPromise;

    const finalState = await conductor.getState();
    testOrchestron.store.close();
    expect(finalState.status).toBe('completed');
    expect(finalState.history).toHaveLength(2);
  });

  it('uses defaultHarness for evaluator and movement fallback', async () => {
    const noHarnessScore: Score = {
      id: 'no-harness-test',
      name: 'No Harness Test',
      version: '1.0.0',
      startMovement: 'step1',
      movements: [
        {
          id: 'step1',
          name: 'Step 1',
          section: 'test',
          prompt: 'Do step 1',
          goal: { description: 'Step 1 done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };

    const scoresDir = join(dir, 'scores');
    mkdirSync(scoresDir, { recursive: true });
    writeScore(scoresDir, noHarnessScore);

    const storePath = join(dir, 'harness-store.db');
    const orchestron = await createOrchestron({
      storePath,
      scoresDirs: [scoresDir],
      adapters: new Map([['fake', new FakeHarnessAdapter({
        defaultResponse: {
          output: 'ok',
          summary: 'ok',
          usage: { spend: 1, tokens: 1 },
          structured: { achieved: true, confidence: 1, summary: 'Goal achieved' },
        },
      })]]),
      defaultHarness: 'fake',
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await startCommandHandler(orchestron, 'no-harness-test', {}, false);
    } finally {
      console.log = originalLog;
      orchestron.store.close();
    }

    expect(logs.some((l) => l.includes('Status:  completed'))).toBe(true);
  });
});
