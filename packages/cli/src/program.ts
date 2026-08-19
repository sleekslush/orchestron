import { Command, Option } from 'commander';
import { withOrchestron, DEFAULT_STORE_PATH, DEFAULT_SCORES_DIR, LOCAL_SCORES_DIR } from './orchestron.js';
import { startCommandHandler } from './commands/start.js';
import {
  pauseCommandHandler,
  resumeCommandHandler,
  cancelCommandHandler,
} from './commands/lifecycle.js';
import { statusCommandHandler } from './commands/status.js';
import { sessionCommandHandler } from './commands/session.js';
import { listCommandHandler } from './commands/list.js';
import { scoresCommandHandler } from './commands/scores.js';
import { modelsCommandHandler } from './commands/models.js';
import { wantsJson } from './output.js';
import { renderRequiredContextHelp } from './required-context.js';

function safeAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`error: ${message}`);
      process.exitCode = 1;
    }
  };
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export function buildProgram(): Command {
  const program = new Command()
    .name('orchestron')
    .description('Orchestron — run and monitor score-based concerts')
    .version('0.1.0')
    .option('--store <path>', 'Path to the SQLite store', DEFAULT_STORE_PATH)
    .option(
      '--scores-dir <dir>',
      'Directory containing .score.yaml files (can be used multiple times). Local ./.orchestron/scores takes priority over ~/.orchestron/scores.',
      collect,
      [LOCAL_SCORES_DIR, DEFAULT_SCORES_DIR],
    )
    .option('--harness <name>', "Default harness for movements without an explicit harness (defaults to 'pi')")
    .option('--json', 'Output JSON instead of human-readable text');

  program
    .command('start <score-id>')
    .description('Start a new concert from a score')
    .allowUnknownOption()
    .addHelpText('after', (ctx) =>
      renderRequiredContextHelp(
        ctx.command.args[0],
        getOrchestronOptions(program).scoresDirs,
      ),
    )
    .action(safeAction(async (scoreId: string, _options: unknown, command: Command) => {
      const { parseContextArgs } = await import('./context.js');
      const context = parseContextArgs(process.argv);
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        startCommandHandler(orchestron, scoreId, context, wantsJson(command)),
      );
    }));

  program
    .command('pause <concert-id>')
    .description('Pause a running concert')
    .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        pauseCommandHandler(orchestron, concertId, wantsJson(command)),
      );
    }));

  program
    .command('resume <concert-id>')
    .description('Resume a paused concert')
    .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        resumeCommandHandler(orchestron, concertId, wantsJson(command)),
      );
    }));

  program
    .command('cancel <concert-id>')
    .description('Cancel a running or paused concert')
    .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        cancelCommandHandler(orchestron, concertId, wantsJson(command)),
      );
    }));

  program
    .command('status [concert-id]')
    .description('Show system status or detailed concert status')
    .option('--verbose', 'Show detailed movement information')
    .option('--watch', 'Tail live events for a running concert')
    .option('--raw', 'With --watch, print raw stream envelopes instead of rendered lines')
    .action(safeAction(async (concertId: string | undefined, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals();
      const verbose = opts.verbose === true;
      const watch = opts.watch === true;
      const raw = opts.raw === true;
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        statusCommandHandler(orchestron, concertId, wantsJson(command), verbose, watch, raw),
      );
    }));

  program
    .command('session <concert-id> <movement-id>')
    .description("Show, render, or open a movement's recorded session artifact")
    .option('--attempt <n>', 'Show a specific attempt index (0 = first) instead of the final one')
    .option('--print', 'Render the session transcript to stdout (display-only)')
    .option('--open', 'Open the session in its harness (pi --fork / opencode import) and block while it runs')
    .action(safeAction(async (concertId: string, movementId: string, _options: unknown, command: Command) => {
      const opts = command.opts() as { attempt?: string; print?: boolean; open?: boolean };
      const attempt = opts.attempt !== undefined ? Number(opts.attempt) : undefined;
      if (opts.attempt !== undefined && (!Number.isInteger(attempt) || (attempt as number) < 0)) {
        throw new Error('--attempt must be a non-negative integer');
      }
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        sessionCommandHandler(orchestron, concertId, movementId, wantsJson(command), attempt, opts.print === true, opts.open === true),
      );
    }));

  program
    .command('list')
    .description('List concerts')
    .addOption(
      new Option('--status <status>', 'Filter by status').choices([
        'pending',
        'running',
        'paused',
        'completed',
        'failed',
        'cancelled',
      ]),
    )
    .action(safeAction(async (_options: unknown, command: Command) => {
      const opts = command.opts();
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        listCommandHandler(orchestron, { status: opts.status }, wantsJson(command)),
      );
    }));

  program
    .command('scores')
    .description('List registered scores')
    .option('--validate', 'Validate all registered scores')
    .action(safeAction(async (_options: unknown, command: Command) => {
      const opts = command.opts();
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        scoresCommandHandler(orchestron, opts.validate === true, wantsJson(command)),
      );
    }));

  program
    .command('models [harness]')
    .description('List available models for all harnesses, or a single harness')
    .action(safeAction(async (harness: string | undefined, _options: unknown, command: Command) => {
      await withOrchestron(getOrchestronOptions(program), (orchestron) =>
        modelsCommandHandler(orchestron, harness, wantsJson(command)),
      );
    }));

  return program;
}

function getOrchestronOptions(program: Command): {
  storePath: string;
  scoresDirs: string[];
  defaultHarness: string | undefined;
} {
  const opts = program.opts();
  return {
    storePath: opts.store,
    scoresDirs: opts.scoresDir,
    defaultHarness: opts.harness,
  };
}