import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../program.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `orchestron-program-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScore(dir: string, score: { id: string; requiredContext?: string[] }): void {
  const required = score.requiredContext
    ? `requiredContext:\n${score.requiredContext.map((k) => `  - ${k}`).join('\n')}\n`
    : '';
  const yaml = `id: ${score.id}
name: ${score.id} Score
version: 1.0.0
${required}startMovement: step1
movements:
  - id: step1
    name: Step 1
    section: default
    harness: fake
    prompt: Do step 1
    goal:
      description: done
      strategy: llm_judge
    transitions:
      - to: __end__
        on: success
program: {}
`;
  writeFileSync(join(dir, `${score.id}.score.yaml`), yaml);
}

interface HelpResult {
  stdout: string;
  stderr: string;
}

/** Parse argv and capture stdout/stderr. `--help`/`-h` cause commander to
 *  exit, so `exitOverride` turns that into a rejection we swallow. */
async function runHelp(argv: string[]): Promise<HelpResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => stdout.push(s),
    writeErr: (s) => stderr.push(s),
  });
  await program.parseAsync(['node', 'orchestron', ...argv]).catch(() => {});
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('orchestron start help', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists each required context key in its --context.<key>=<value> form', async () => {
    writeScore(dir, { id: 'req-help', requiredContext: ['ticket', 'project.name'] });

    const { stdout, stderr } = await runHelp(['--scores-dir', dir, 'start', 'req-help', '--help']);

    expect(stderr).toBe('');
    expect(stdout).toContain('Required context:');
    expect(stdout).toContain('  --context.ticket=<value>');
    expect(stdout).toContain('  --context.project.name=<value>');
  });

  it('supports -h the same as --help', async () => {
    writeScore(dir, { id: 'req-help', requiredContext: ['ticket'] });

    const { stdout } = await runHelp(['--scores-dir', dir, 'start', 'req-help', '-h']);

    expect(stdout).toContain('Required context:');
    expect(stdout).toContain('  --context.ticket=<value>');
  });

  it('states when a score declares no required context', async () => {
    writeScore(dir, { id: 'plain' });

    const { stdout } = await runHelp(['--scores-dir', dir, 'start', 'plain', '--help']);

    expect(stdout).toContain('Required context:');
    expect(stdout).toContain('This score declares no required context.');
  });

  it('shows a hint when no score id is given', async () => {
    const { stdout } = await runHelp(['start', '--help']);

    expect(stdout).toContain('Usage: orchestron start');
    expect(stdout).toContain('To see a score\'s required context run: orchestron start <score-id> --help');
  });

  it('notes when the score cannot be found', async () => {
    const { stdout } = await runHelp(['--scores-dir', dir, 'start', 'missing', '--help']);

    expect(stdout).toContain('score \'missing\' not found in the configured scores directories');
  });

  it('renders help without constructing the full Orchestron stack', async () => {
    // If help inspection were routed through createOrchestron, the store
    // (and its `concerts` traces dir) would be created next to --store.
    writeScore(dir, { id: 'req-help', requiredContext: ['ticket'] });
    const storePath = join(dir, 'should-not-exist.db');

    const { stdout, stderr } = await runHelp([
      '--store', storePath,
      '--scores-dir', dir,
      'start', 'req-help', '--help',
    ]);

    expect(stderr).toBe('');
    expect(stdout).toContain('  --context.ticket=<value>');
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(dir, 'concerts'))).toBe(false);
  });

  it('still finds the score when an invalid score file sorts before it', async () => {
    // A malformed .score.yaml that loads before the target must not abort
    // loading the rest of the directory.
    writeScore(dir, { id: 'req-help', requiredContext: ['ticket'] });
    writeFileSync(join(dir, 'aaa-broken.score.yaml'), 'id: [unclosed\nnot: - valid: yaml\n');

    const { stdout } = await runHelp(['--scores-dir', dir, 'start', 'req-help', '--help']);

    expect(stdout).toContain('  --context.ticket=<value>');
  });
});
