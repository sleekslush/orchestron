import type { Command } from 'commander';

export function wantsJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function printOutput(
  json: boolean,
  data: unknown,
  humanFormatter: () => string,
): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(humanFormatter());
  }
}

export function formatDate(d: Date | undefined): string {
  if (!d) return '-';
  return d.toISOString();
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatUsage(usage: { spend?: number; tokens?: number }): string {
  const spend = usage.spend ?? 0;
  const tokens = usage.tokens ?? 0;
  return `$${(spend / 1_000_000).toFixed(6)} / ${tokens} tokens`;
}
