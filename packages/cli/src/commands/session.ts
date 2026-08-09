import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Orchestron } from '../orchestron.js';
import { NATIVE_SESSION_FILE } from '@orchestron/core';

interface MoveIndex {
  concertId?: string;
  movementId?: string;
  movementName?: string;
  harness?: string;
  mode?: 'cumulative' | 'fresh';
  finalAttempt?: number;
  finalStatus?: string;
  finalSessionFile?: string;
  attempts?: Array<{
    attempt: number;
    status: string;
    sessionKey?: string;
    path: string;
  }>;
}

interface AttemptMeta {
  concertId?: string;
  movementId?: string;
  attempt?: number;
  harness?: string;
  mode?: 'cumulative' | 'fresh';
  sessionKey?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  eventCount?: number;
  files?: { native?: string; sizeBytes?: number };
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function reopenHint(harness: string | undefined, filePath: string): string | undefined {
  if (harness === 'pi') {
    // Fork, don't open in place: --session <path> makes the recorded file the
    // live session store, so continuing would rewrite the artifact. --fork reads
    // it and writes a new session into pi's session store (parentSession set).
    return `pi --fork ${filePath}`;
  }
  if (harness === 'opencode') {
    return `opencode import ${filePath}`;
  }
  return undefined;
}

export async function sessionCommandHandler(
  orchestron: Orchestron,
  concertId: string | undefined,
  movementId: string,
  json: boolean,
  attempt?: number,
  print = false,
  open = false,
): Promise<void> {
  if (!concertId) {
    throw new Error('concert id is required');
  }
  if (open && (print || json)) {
    throw new Error('--open cannot be combined with --print or --json');
  }

  const movementDir = join(orchestron.tracesDir, concertId, 'movements', movementId);
  const index = await readJson<MoveIndex>(join(movementDir, 'index.json'));

  // Display metadata from the movement index when no explicit attempt is requested.
  let status: string | undefined;
  let mode: 'cumulative' | 'fresh' | undefined;
  if (attempt === undefined && index) {
    status = index.finalStatus;
    mode = index.mode;
  }

  const chooseAttempt = (): { attempt: number; path: string } | undefined => {
    const native = NATIVE_SESSION_FILE[index?.harness ?? ''];
    // Explicit --attempt N: that attempt's native session file (dir fallback).
    if (attempt !== undefined && attempt >= 0) {
      return { attempt, path: native ? join(`attempt-${attempt}`, native) : `attempt-${attempt}` };
    }
    // Default: the movement's finalized session file — `final-*` for cumulative,
    // `attempt-N/<native>` for fresh sessions.
    if (index?.finalSessionFile) {
      const split = index.finalSessionFile.split('/');
      const attemptMatch = (index.attempts ?? [])
        .filter((a) => a.path === split[0])
        .sort((a, b) => b.attempt - a.attempt)[0];
      return {
        attempt: attemptMatch?.attempt ?? index.finalAttempt ?? 0,
        path: index.finalSessionFile,
      };
    }
    const lastAttempt = (index?.attempts ?? []).sort((a, b) => b.attempt - a.attempt)[0];
    if (!lastAttempt) return undefined;
    return { attempt: lastAttempt.attempt, path: native ? join(lastAttempt.path, native) : lastAttempt.path };
  };

  const chosen = chooseAttempt();
  if (!chosen) {
    throw new Error(
      `No recorded session found for concert '${concertId}' movement '${movementId}'. ` +
        `(No recordings for a concert run without a recordings directory.)`,
    );
  }

  const sessionPath = resolve(join(movementDir, chosen.path));
  const meta = await readJson<AttemptMeta>(join(movementDir, `attempt-${chosen.attempt}`, 'metadata.json'));
  const harness = meta?.harness ?? index?.harness;
  const modeOut = meta?.mode ?? mode;
  const motionStatus = meta?.status ?? status;
  const native = NATIVE_SESSION_FILE[harness ?? ''];

  const output = {
    concertId,
    movementId,
    attempt: chosen.attempt,
    finalAttempt: index?.finalAttempt,
    harness,
    mode: modeOut,
    movementStatus: index?.finalStatus,
    attemptStatus: motionStatus,
    sessionKey: meta?.sessionKey ?? (index?.attempts ?? []).find((a) => a.attempt === chosen.attempt)?.sessionKey,
    sessionId: meta?.sessionId,
    eventCount: meta?.eventCount,
    filePath: sessionPath,
    sizeBytes: meta?.files?.sizeBytes,
    reopen: reopenHint(harness, sessionPath),
  };

  if (open) {
    openInHarness(harness, sessionPath);
    return;
  }

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (print) {
    if (harness === 'pi') {
      const transcript = await renderPiTranscript(sessionPath);
      if (transcript) {
        console.log(transcript);
        return;
      }
    } else if (harness === 'opencode') {
      const transcript = await renderOpencodeTranscript(sessionPath);
      if (transcript) {
        console.log(transcript);
        return;
      }
    }
    console.log(`(no printable transcript for ${harness ?? 'unknown'} artifact)`);
    return;
  }

  const lines: string[] = [];
  lines.push(`Concert:  ${concertId}`);
  lines.push(`Movement: ${movementId}${index?.movementName ? ` (${index.movementName})` : ''}`);
  lines.push(`Attempt:  ${chosen.attempt}${index?.finalAttempt === chosen.attempt ? ' (final)' : ''}`);
  lines.push(`Harness:  ${harness ?? '-'}`);
  lines.push(`Mode:     ${modeOut ?? '-'}`);
  lines.push(`Status:   ${motionStatus ?? '-'}`);
  if (meta?.sessionKey) lines.push(`Pool key: ${meta.sessionKey}`);
  if (meta?.sessionId) lines.push(`SDK id:   ${meta.sessionId}`);
  if (meta?.eventCount !== undefined) lines.push(`Events:   ${meta.eventCount}`);
  lines.push(`File:     ${sessionPath}`);
  if (meta?.files?.sizeBytes !== undefined) lines.push(`Size:     ${meta.files.sizeBytes} bytes`);
  const hint = reopenHint(harness, sessionPath);
  if (hint) lines.push(`Reopen:   ${hint}`);
  lines.push('');
  lines.push(`Attempts: ${(index?.attempts ?? [])
    .sort((a, b) => a.attempt - b.attempt)
    .map((a) => `${a.attempt} (${a.status})`)
    .join(', ') || '-'}`);
  if (index?.mode === 'cumulative') {
    lines.push('(cumulative session: retries share one session; final snapshot is the full session)');
  } else {
    lines.push('(fresh sessions: each attempt is its own session)');
  }
  console.log(lines.join('\n'));
}

/** Launch the harness with the session opened; blocks until it exits. */
function openInHarness(harness: string | undefined, filePath: string): void {
  let args: string[];
  if (harness === 'pi') {
    args = ['--fork', filePath];
  } else if (harness === 'opencode') {
    args = ['import', filePath];
  } else {
    throw new Error(`No known way to open a session in harness '${harness ?? 'unknown'}'`);
  }
  console.error(`Opening session in ${harness}: ${filePath}`);
  const res = spawnSync(harness, args, { stdio: 'inherit' });
  if (res.error) {
    throw new Error(`Failed to launch ${harness}: ${res.error.message}`);
  }
  process.exitCode = res.status ?? 1;
}

/** Render a pi session export as a readable terminal transcript (display-only). */
export async function renderPiTranscript(filePath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  const lines: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: unknown } | undefined;
    try {
      entry = JSON.parse(line) as { type?: unknown; message?: unknown };
    } catch {
      continue;
    }
    if (entry && entry.type === 'message') {
      const msg = entry.message as {
        role?: unknown;
        content?: unknown;
        model?: unknown;
        provider?: unknown;
        usage?: { cost?: { total?: number }; input?: number; output?: number };
      };
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof msg.role === 'string' ? msg.role : 'unknown';
      const content = msg.content;
      if (role === 'user') {
        const text = piContentToText(content);
        if (text) lines.push(`\n> ${text}`);
      } else if (role === 'assistant') {
        for (const block of piBlocks(content)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            lines.push(block.text + '\n');
          } else if (block.type === 'reasoning' && typeof block.text === 'string') {
            lines.push(`[reasoning] ${block.text}\n`);
          } else if (block.type === 'toolCall') {
            const toolName = typeof block.name === 'string' ? block.name : 'unknown';
            const args = typeof block.arguments === 'string' || typeof block.arguments === 'object'
              ? JSON.stringify(block.arguments)
              : '';
            lines.push(`\n\`\`\`tool ${toolName}\n${args}\n\`\`\`\n`);
          }
        }
        const usage = msg.usage;
        if (usage && (usage.cost?.total || usage.input || usage.output)) {
          const cost = usage.cost?.total ? `$${usage.cost.total.toFixed(4)}` : '';
          lines.push(`[${usage.input ?? 0} in / ${usage.output ?? 0} out tokens${cost ? ` · ${cost}` : ''}]\n`);
        }
      } else if (role === 'toolResult') {
        const toolName = typeof (msg as { toolName?: unknown }).toolName === 'string'
          ? String((msg as { toolName: unknown }).toolName)
          : 'tool';
        const isError = (msg as { isError?: unknown }).isError === true;
        const text = piContentToText(content);
        lines.push(`\`\`\`tool-result ${toolName}${isError ? ' [error]' : ''}\n${text}\n\`\`\`\n`);
      }
    }
  }

  return lines.join('').trim() || undefined;
}

function piBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object');
}

function piContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocks = piBlocks(content);
  const parts = blocks
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'toolResult' && typeof b.content === 'string') return b.content;
      return '';
    })
    .filter(Boolean);
  return parts.join('\n');
}

/** Render an opencode session artifact ({"info","messages"}) as a transcript. */
export async function renderOpencodeTranscript(filePath: string): Promise<string | undefined> {
  const parsed = await readJson<{
    info?: unknown;
    messages?: Array<{ info?: { role?: unknown; time?: { created?: number } }; parts?: unknown[] }>;
  }>(filePath);
  if (!parsed || !Array.isArray(parsed.messages)) return undefined;

  const lines: string[] = [];
  for (const msg of parsed.messages) {
    const role = typeof msg.info?.role === 'string' ? msg.info.role : 'unknown';
    const created = msg.info?.time?.created;
    const stamp = typeof created === 'number' ? new Date(created).toISOString() : undefined;
    const prefix = stamp ? `${stamp} ` : '';
    if (role === 'user') {
      const text = opencodeText(msg.parts);
      if (text) lines.push(`\n${prefix}> ${text}`);
    } else if (role === 'assistant') {
      const text = opencodeText(msg.parts);
      if (text) lines.push(`${prefix}${text}\n`);
      for (const part of msg.parts ?? []) {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool') {
          const p = part as { tool?: unknown; state?: { status?: unknown; input?: unknown; output?: string; error?: string } };
          const toolName = typeof p.tool === 'string' ? p.tool : 'unknown';
          const input = p.state?.input !== undefined ? JSON.stringify(p.state.input) : '';
          const outcome =
            p.state?.error !== undefined && p.state.error
              ? ` [error: ${p.state.error.length > 200 ? p.state.error.slice(0, 200) + '…' : p.state.error}]`
              : '';
          let outputText = '';
          if (typeof p.state?.output === 'string' && p.state.output) {
            outputText = p.state.output.length > 400 ? p.state.output.slice(0, 400) + '…' : p.state.output;
          }
          lines.push(`\n\`\`\`tool ${toolName}${outcome}\n${input.trim()}${input.trim() && outputText ? '\n' : ''}${outputText}\n\`\`\`\n`);
        }
      }
    } else if (typeof role === 'string') {
      // tool/other message roles: show nothing structural; keep transcript clean.
    }
  }

  return lines.join('').trim() || undefined;
}

function opencodeText(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}