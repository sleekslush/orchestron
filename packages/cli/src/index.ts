#!/usr/bin/env node
import { Command } from 'commander';
import { createOrchestron, DEFAULT_STORE_PATH, DEFAULT_SCORES_DIR } from './orchestron.js';
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
    'Directory containing .score.yaml/.score.json files (can be used multiple times)',
    collect,
    [DEFAULT_SCORES_DIR],
  )
  .option('--json', 'Output JSON instead of human-readable text');

program
  .command('start <score-id>')
  .description('Start a new concert from a score')
  .allowUnknownOption()
  .action(async (scoreId: string, _options: unknown, command: Command) => {
    const { parseContextArgs } = await import('./context.js');
    const context = parseContextArgs(process.argv);
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await startCommandHandler(orchestron, scoreId, context, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('pause <concert-id>')
  .description('Pause a running concert')
  .action(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await pauseCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('resume <concert-id>')
  .description('Resume a paused concert')
  .action(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await resumeCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('cancel <concert-id>')
  .description('Cancel a running or paused concert')
  .action(async (concertId: string, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await cancelCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('status [concert-id]')
  .description('Show system status or detailed concert status')
  .action(async (concertId: string | undefined, _options: unknown, command: Command) => {
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await statusCommandHandler(orchestron, concertId, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('list')
  .description('List concerts')
  .option('--status <status>', 'Filter by status')
  .action(async (_options: unknown, command: Command) => {
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
  });

program
  .command('scores')
  .description('List registered scores')
  .option('--validate', 'Validate all registered scores')
  .action(async (_options: unknown, command: Command) => {
    const opts = command.opts();
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    try {
      await scoresCommandHandler(orchestron, opts.validate === true, wantsJson(command));
    } finally {
      orchestron.store.close();
    }
  });

program
  .command('dashboard')
  .description('Launch the dashboard server')
  .option('--port <port>', 'Port to run the dashboard server on', '3000')
  .action(async (_options: unknown, command: Command) => {
    const opts = command.opts();
    const orchestron = await createOrchestron(getOrchestronOptions(program));
    await dashboardCommandHandler(orchestron, Number(opts.port));
  });

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
