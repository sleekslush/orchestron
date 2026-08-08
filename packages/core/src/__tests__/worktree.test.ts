import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, type GitRunner } from '../worktree/worktree-manager.js';
import type { Score } from '../types/score.js';

function makeScore(overrides: Partial<Score> = {}): Score {
  return {
    id: 'test-score',
    name: 'Test',
    version: '1.0.0',
    startMovement: 'm1',
    movements: [],
    metadata: { baseBranch: 'origin/main' },
    ...overrides,
  };
}

describe('WorktreeManager', () => {
  it('creates a worktree from the default origin/main and returns its path/branch', async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const git: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return '';
    };
    const manager = new WorktreeManager(git);

    const handle = await manager.create(makeScore({ metadata: {} }), {}, 'abc123', '/src');

    expect(handle.branch).toMatch(/^orchestron\/wt-abc123-/);
    expect(handle.path).toContain('.orchestron-wt-abc123-');
    expect(handle.path).not.toContain('/src/');
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/src');
    expect(calls[0].args[0]).toBe('worktree');
    expect(calls[0].args).toContain('origin/main');
  });

  it('respects an explicit baseBranch option over the score metadata default', async () => {
    const calls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      calls.push({ args });
      return '';
    };
    const manager = new WorktreeManager(git);

    await manager.create(makeScore(), { baseBranch: 'origin/dev' }, 'abc123', '/src');

    expect(calls[0].args).toContain('origin/dev');
    expect(calls[0].args).not.toContain('origin/main');
  });

  it('uses score metadata.baseBranch when no explicit option is given', async () => {
    const calls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      calls.push({ args });
      return '';
    };
    const manager = new WorktreeManager(git);

    await manager.create(makeScore({ metadata: { baseBranch: 'origin/custom' } }), {}, 'abc123', '/src');

    expect(calls[0].args).toContain('origin/custom');
  });

  it('disposes the worktree and deletes the branch', async () => {
    const calls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      calls.push({ args });
      return '';
    };
    const manager = new WorktreeManager(git);

    await manager.remove('/wt/path', 'orchestron/wt-abc', '/src');

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['worktree', 'remove', '--force', '/wt/path']);
    expect(calls[1].args).toEqual(['branch', '-D', 'orchestron/wt-abc']);
  });

  it('does not throw when disposal git commands fail', async () => {
    const git: GitRunner = vi.fn(async () => {
      throw new Error('git failed');
    });
    const manager = new WorktreeManager(git);

    await expect(manager.remove('/wt/path', 'orchestron/wt-abc', '/src')).resolves.toBeUndefined();
  });
});

describe('WorktreeManager + ConcertHall integration', () => {
  function hallScore(): Score {
    return {
      id: 'wt-score',
      name: 'WT',
      version: '1.0.0',
      startMovement: 'm1',
      metadata: { baseBranch: 'origin/main' },
      movements: [
        {
          id: 'm1',
          name: 'M1',
          section: 'default',
          harness: 'fake',
          prompt: 'Do m1',
          goal: { description: 'done', strategy: 'llm_judge' },
          transitions: [{ to: '__end__', on: 'success' }],
        },
      ],
      program: {},
    };
  }

  it('runs the concert in the worktree cwd and disposes it on completion', async () => {
    const { SqliteLoge, ScoreRegistry, ConcertHall, FakeHarnessAdapter, FakeEvaluator } =
      await import('../index.js');

    const gitCalls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      return '';
    };

    const capturedCwds: string[] = [];
    class RecordingAdapter extends FakeHarnessAdapter {
      async execute(prompt: string, context: any, options?: any) {
        if (options?.cwd) capturedCwds.push(options.cwd);
        return super.execute(prompt, context, options);
      }
    }

    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(hallScore());
    const adapter = new RecordingAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 1, tokens: 1 } },
    });
    const concertsDir = mkdtempSync(join(tmpdir(), 'orchestron-wt-test-'));
    try {
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['fake', adapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        concertsDir,
        worktreeManager: new WorktreeManager(git),
      });

      const conductor = await hall.createConcert('wt-score', {
        worktree: true,
        triggeredBy: 'cli',
      });
      await conductor.start();

      // Movement ran inside the worktree path.
      expect(capturedCwds).toHaveLength(1);
      expect(capturedCwds[0]).toMatch(/.orchestron-wt-/);

      // Worktree was created and then disposed on terminal state.
      const addCall = gitCalls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
      const removeCall = gitCalls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
      expect(addCall).toBeDefined();
      expect(removeCall).toBeDefined();
      // The removed path matches the created path.
      expect(removeCall!.args[3]).toBe(addCall!.args[5]);
    } finally {
      rmSync(concertsDir, { recursive: true, force: true });
    }
  });

  it('does not dispose the worktree when keep is set', async () => {
    const { SqliteLoge, ScoreRegistry, ConcertHall, FakeHarnessAdapter, FakeEvaluator } =
      await import('../index.js');

    const gitCalls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      return '';
    };

    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(hallScore());
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 1, tokens: 1 } },
    });
    const concertsDir = mkdtempSync(join(tmpdir(), 'orchestron-wt-test-'));
    try {
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['fake', adapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        concertsDir,
        worktreeManager: new WorktreeManager(git),
      });

      const conductor = await hall.createConcert('wt-score', {
        worktree: { keep: true },
      });
      await conductor.start();
      expect(conductor.status).toBe('completed');

      expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(true);
      expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    } finally {
      rmSync(concertsDir, { recursive: true, force: true });
    }
  });

  it('disposes the worktree when createConcert fails after worktree creation', async () => {
    const { ScoreRegistry, ConcertHall, FakeHarnessAdapter, FakeEvaluator, SqliteLoge } =
      await import('../index.js');

    let saveShouldThrow = false;
    class FailingSaveStore extends SqliteLoge {
      async saveConcert(concert: any, scoreYaml: string): Promise<void> {
        if (saveShouldThrow) throw new Error('db down');
        return super.saveConcert(concert, scoreYaml);
      }
    }

    const gitCalls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      return '';
    };

    const store = new FailingSaveStore(':memory:');
    const registry = new ScoreRegistry();
    registry.register(hallScore());
    const adapter = new FakeHarnessAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 1, tokens: 1 } },
    });
    const concertsDir = mkdtempSync(join(tmpdir(), 'orchestron-wt-test-'));
    try {
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['fake', adapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        concertsDir,
        worktreeManager: new WorktreeManager(git),
      });

      saveShouldThrow = true;
      await expect(
        hall.createConcert('wt-score', { worktree: true }),
      ).rejects.toThrow('db down');

      // The worktree was created then removed when saveConcert failed.
      expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(true);
      expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    } finally {
      rmSync(concertsDir, { recursive: true, force: true });
    }
  });

  it('rehydrates a worktree concert with its cwd and disposer from the persisted record', async () => {
    const { SqliteLoge, ScoreRegistry, ConcertHall, FakeHarnessAdapter, FakeEvaluator } =
      await import('../index.js');

    const gitCalls: Array<{ args: string[] }> = [];
    const git: GitRunner = async (args) => {
      gitCalls.push({ args });
      return '';
    };

    const capturedCwds: string[] = [];
    class RecordingAdapter extends FakeHarnessAdapter {
      async execute(prompt: string, context: any, options?: any) {
        if (options?.cwd) capturedCwds.push(options.cwd);
        return super.execute(prompt, context, options);
      }
    }

    const store = new SqliteLoge(':memory:');
    const registry = new ScoreRegistry();
    registry.register(hallScore());
    const adapter = new RecordingAdapter({
      defaultResponse: { output: 'out', summary: 'sum', usage: { spend: 1, tokens: 1 } },
    });
    const concertsDir = mkdtempSync(join(tmpdir(), 'orchestron-wt-test-'));
    try {
      const hall = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['fake', adapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        concertsDir,
        worktreeManager: new WorktreeManager(git),
      });

      // Create (but do not start) a worktree concert so the record is persisted.
      const original = await hall.createConcert('wt-score', { worktree: true });
      const path = (await original.getState()).worktree!.path;

      // Simulate a restart: a fresh hall over the same store rehydrates the record.
      const hall2 = new ConcertHall({
        store,
        scoreRegistry: registry,
        adapters: new Map([['fake', adapter]]),
        evaluator: new FakeEvaluator({ alwaysSucceed: true }),
        concertsDir,
        worktreeManager: new WorktreeManager(git),
      });
      const rehydrated = await hall2.loadConcert(original.concertId);
      expect((await rehydrated!.getState()).worktree).toBeDefined();

      await rehydrated!.start();
      expect(rehydrated!.status).toBe('completed');

      // Harness sessions ran inside the restored worktree path.
      expect(capturedCwds.length).toBeGreaterThan(0);
      expect(capturedCwds[0]).toBe(path);

      // The restored disposer removed the worktree on terminal state.
      expect(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    } finally {
      rmSync(concertsDir, { recursive: true, force: true });
    }
  });
});
