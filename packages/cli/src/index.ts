#!/usr/bin/env node
import { Command, Option } from 'commander';
import { createOrchestron, DEFAULT_STORE_PATH, DEFAULT_SCORES_DIR, LOCAL_SCORES_DIR } from './orchestron.js';
import { startCommandHandler } from './commands/start.js';
import {
  pauseCommandHandler,
  resumeCommandHandler,
  cancelCommandHandler,
} from './commands/lifecycle.js';
import { statusCommandHandler } from './commands/status.js';
import { listCommandHandler } from './commands/list.js';
import { scoresCommandHandler } from './commands/scores.js';
import { dashboardCommandHandler } from './commands/dashboard.js';
import { wantsJson } from './output.js';

function safeAction(
  fn: (...args: any[]) => Promise<void>,
): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
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

const program = new Command()
  .name('orchestron')
  .description('Orchestron — run and monitor score-based concerts')
  .version('0.1.0')
  .option('--store <path>', 'Path to the SQLite store', DEFAULT_STORE_PATH)
  .option(
    '--scores-dir <dir>',
    'Directory containing .score.yaml/.score.json files (can be used multiple times). Local ./.orchestron/scores takes priority over ~/.orchestron/scores.',
    collect,
    [LOCAL_SCORES_DIR, DEFAULT_SCORES_DIR],
  )
  .option('--json', 'Output JSON instead of human-readable text');

program
  .command('start <score-id>')
  .description('Start a new concert from a score')
  .allowUnknownOption()
  .action(safeAction(async (scoreId: string, _options: unknown, command: Command) => {
    const { parseContextArgs } = await import('./context.js');
    const context = parseContextArgs(process.argv);
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await startCommandHandler(orchestron, scoreId, context, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('pause <concert-id>')
  .description('Pause a running concert')
  .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await pauseCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('resume <concert-id>')
  .description('Resume a paused concert')
  .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await resumeCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('cancel <concert-id>')
  .description('Cancel a running or paused concert')
  .action(safeAction(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await cancelCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('status [concert-id]')
  .description('Show system status or detailed concert status')
  .action(safeAction(async (concertId: string | undefined, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await statusCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
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
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await listCommandHandler(
        orchestron,
        { status: opts.status },
        wantsJson(command),
      );
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('scores')
  .description('List registered scores')
  .option('--validate', 'Validate all registered scores')
  .action(safeAction(async (_options: unknown, command: Command) => {
    const opts = command.opts();
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await scoresCommandHandler(orchestron, opts.validate === true, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  }));

program
  .command('dashboard')
  .description('Launch the dashboard server')
  .option('--port <port>', 'Port to run the dashboard server on', '3000')
  .action(safeAction(async (_options: unknown, command: Command) => {
    const opts = command.opts();
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`error: option '--port <port>' argument '${opts.port}' is invalid. Must be an integer between 1 and 65535.`);
      process.exit(1);
    }
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    await dashboardCommandHandler(orchestron, port);
  }));

function getOrchestronOptions(program: Command): {
  storePath: string;
  scoresDirs: string[];
} {
  const opts = program.opts();
  return {
    storePath: opts.store,
    scoresDirs: opts.scoresDir,
  };
}

await program.parseAsync(process.argv);
