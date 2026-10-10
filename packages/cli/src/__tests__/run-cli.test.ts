import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestron } from '../orchestron.js';
import { FakeHarnessAdapter, FakeEvaluator } from '@orchestron/core';
import { startCommandHandler } from '../commands/start.js';
import { statusCommandHandler } from '../commands/status.js';
import { sessionCommandHandler } from '../commands/session.js';

const NODE = process.execPath;

function runScoreYaml(): string {
  return `id: run-cli
name: Run CLI
version: 1.0.0
startMovement: run
movements:
  - id: run
    name: Run
    section: default
    type: run
    command:
      - ${JSON.stringify(NODE)}
      - "-e"
      - "process.stdout.write('ran'); process.stderr.write('warn')"
    transitions:
      - to: __end__
        on: success
program: {}
`;
}

function captureOutput(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (msg: string) => logs.push(String(msg));
  console.error = (msg: string) => errs.push(String(msg));
  return {
    logs,
    errs,
    restore: () => {
      console.log = originalLog;
      console.error = originalErr;
    },
  };
}

describe('CLI run movements', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchestron-cli-run-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const scoresDir = join(dir, 'scores');
    mkdirSync(scoresDir, { recursive: true });
    writeFileSync(join(scoresDir, 'run-cli.score.yaml'), runScoreYaml());
    return createOrchestron({
      storePath: join(dir, 'store.db'),
      scoresDirs: [scoresDir],
      adapters: new Map([['fake', new FakeHarnessAdapter({})]]),
      evaluator: new FakeEvaluator({ alwaysSucceed: true }),
      defaultHarness: 'fake',
    });
  }

  it('surfaces the exit code in start JSON output and renders run progress', async () => {
    const orchestron = await setup();
    const { logs, errs, restore } = captureOutput();
    try {
      await startCommandHandler(orchestron, 'run-cli', {}, true);
    } finally {
      restore();
      orchestron.store.close();
    }
    const output = JSON.parse(logs[logs.length - 1]);
    expect(output.movements[0].exitCode).toBe(0);
    expect(output.movements[0].status).toBe('completed');
    // start's live renderer prints the run-start command and the exit line.
    expect(errs.some((l) => l.includes('$ '))).toBe(true);
    expect(errs.some((l) => l.includes('exit 0'))).toBe(true);
  });

  it('shows the exit code in human status output', async () => {
    const orchestron = await setup();
    const startCapture = captureOutput();
    try {
      await startCommandHandler(orchestron, 'run-cli', {}, true);
    } finally {
      startCapture.restore();
    }
    const concertId = (await orchestron.store.listConcerts())[0].id;

    const { logs, restore } = captureOutput();
    try {
      await statusCommandHandler(orchestron, concertId, false, true);
    } finally {
      restore();
      orchestron.store.close();
    }
    expect(logs.some((l) => l.includes('exit 0'))).toBe(true);
    // A finished run movement must not leave a stale "Running:" line.
    expect(logs.some((l) => l.includes('Running:'))).toBe(false);
  });

  it('renders run stdout/stderr through session and rejects --open', async () => {
    const orchestron = await setup();
    const startCapture = captureOutput();
    try {
      await startCommandHandler(orchestron, 'run-cli', {}, true);
    } finally {
      startCapture.restore();
    }
    const concertId = (await orchestron.store.listConcerts())[0].id;

    const { logs, restore } = captureOutput();
    try {
      await sessionCommandHandler(orchestron, concertId, 'run', true);
    } finally {
      restore();
    }
    const parsed = JSON.parse(logs[logs.length - 1]);
    expect(parsed.kind).toBe('run');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe('ran');
    expect(parsed.stderr).toBe('warn');

    await expect(
      sessionCommandHandler(orchestron, concertId, 'run', false, undefined, false, true),
    ).rejects.toThrow('--open is not supported for run movements');
    orchestron.store.close();
  });
});
