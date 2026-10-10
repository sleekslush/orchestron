import type { ConcertEvent } from '@orchestron/core';

export type ProgressCallback = (text: string) => void;

/**
 * Format a single conductor stream event as human-readable progress text.
 *
 * Shared by the observe-side tools (currently `orchestron_wait_for_concert`)
 * so progress rendering exists in exactly one place. Non-progress events and
 * progress events without a meaningful message return `undefined`.
 */
export function progressText(event: ConcertEvent): string | undefined {
  if (event.type !== 'movement:progress') return undefined;
  const payload = event.payload;
  let text =
    (payload.message as string | undefined) ??
    `Progress: ${event.progressType}${payload.toolName ? ` (${payload.toolName as string})` : ''}`;
  if (event.progressType === 'tool_execution_start' && payload.args) {
    const args = payload.args as Record<string, unknown>;
    const cmd =
      (args.command as string | undefined) ??
      (args.filePath as string | undefined) ??
      (args.file as string | undefined) ??
      (args.path as string | undefined);
    if (cmd) {
      text += ` → ${cmd}`;
    }
  }
  if (event.progressType === 'tool_execution_end' && payload.isError) {
    text += ` [error]`;
  }
  if (event.progressType === 'text_delta' && typeof payload.delta === 'string') {
    text += ` ${payload.delta}`;
  }
  if (event.progressType === 'run_start' && Array.isArray(payload.command)) {
    text = `Running: ${(payload.command as string[]).join(' ')}`;
  } else if (event.progressType === 'run_stdout' && typeof payload.chunk === 'string') {
    text = payload.chunk;
  } else if (event.progressType === 'run_stderr' && typeof payload.chunk === 'string') {
    text = `[stderr] ${payload.chunk}`;
  } else if (event.progressType === 'run_exit') {
    text = `Run exited with code ${String(payload.exitCode ?? '?')}`;
  }
  return text;
}
