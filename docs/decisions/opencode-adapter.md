# Opencode Harness Adapter

**Status:** Decided
**Date:** 2026-07-12
**Related:** Phase 4 (Opencode Harness Adapter), `docs/decisions/session-persistence.md`

## Context

After completing the Pi adapter, we needed a second harness adapter to prove
that Orchestron's core is genuinely harness-agnostic. The opencode adapter must:

- Reuse the same `HarnessAdapter` interface as Pi.
- Support native structured output.
- Support session persistence across movement re-executions.
- Handle cancellation, usage tracking, and graceful cleanup.
- Keep all opencode-specific code inside `packages/adapter-opencode/`.

## Decision

### SDK version

We use `@opencode-ai/sdk/v2` because the v2 SDK is the only variant that
exposes native structured-output types (`OutputFormat`, `AssistantMessage.structured`)
in the installed package. The v1 SDK types lack the `format` field on prompt
requests and the `structured` field on responses, so the adapter would have to
fall back to prompt injection and text parsing. Using v2 keeps the structured
output path clean and native.

### Connection modes

The adapter supports two connection modes, controlled by config:

1. **Client-only** (default): `createOpencodeClient({ baseUrl })`.
   - Defaults to `http://localhost:4096`.
   - The adapter does not own the server lifecycle.
2. **Embedded server**: `createOpencode({ hostname, port, config })`.
   - The adapter owns the server and closes it in `dispose()`.

This mirrors the SDK's own entry points while leaving the caller in control.

### Session persistence

The adapter follows the same pattern established in `session-persistence.md`:

- `sessionId` is passed by the conductor as `${concertId}:${movementId}`.
- The adapter maintains `Map<sessionId, { opencodeSessionId }>`.
- `execute()` with a known `sessionId` reuses the existing opencode session.
- `execute()` with a new `sessionId` creates an opencode session titled with the
  internal id, then stores the mapping.
- `execute()` without a `sessionId` creates an ephemeral session and deletes it in
  `finally`.
- A session lock prevents concurrent creation of the same session.

### Native structured output

When `output.mode === 'structured'` and a schema is provided, the adapter passes:

```typescript
format: { type: 'json_schema', schema }
```

in the prompt parameters. The parsed result is then read from
`response.data.info.structured` and returned as `HarnessResponse.structured`.

The adapter does not inject JSON schema instructions into the prompt text when
using structured mode; the harness handles that. This is the key difference
from the Pi adapter, which injects instructions because Pi's agent session API
does not expose a native structured-output format.

### Usage extraction

The v2 `AssistantMessage` includes `cost` (number) and `tokens` (object). The
adapter maps these to `ResourceUsage`:

- `spend`: `cost * 1_000_000` (micro-dollars)
- `tokens`: `tokens.total` if present, otherwise `input + output`
- `inputTokens`: `tokens.input`
- `outputTokens`: `tokens.output`

If the fields are missing, the adapter falls back to `{}`.

### Abort signal handling

The adapter attaches an abort listener that calls `client.session.abort({
sessionID })`. The SDK's prompt promise rejects when the session is aborted, and
the adapter converts that into `HARNESS_TIMEOUT`.

### Global cleanup

`HarnessAdapter` gains an optional `dispose(): Promise<void>` method. This is
used by `OpencodeAdapter` to:

- Delete all tracked sessions.
- Close the embedded server if the adapter owns it.

The conductor does **not** call `adapter.dispose()` at the end of a concert; the
conductor only calls `disposeSession()` per active session. Global adapter
cleanup is the responsibility of the process owner (e.g. CLI shutdown, plugin
deactivation). This keeps the conductor harness-agnostic.

## Consequences

- All opencode-specific SDK calls, v2 API shapes, and structured-output logic are
  isolated in `packages/adapter-opencode/`. Core and the conductor remain
  unaware of opencode.
- The Pi adapter is unaffected; it already had an informal `dispose()` method, and
  the new interface field is optional.
- Native structured output means the adapter relies on the harness to validate
  and return JSON. If the harness fails, the resulting `HarnessResponse` will
  have `structured: undefined` and the conductor/evaluator will treat it as a
  failed goal.
- The v2 SDK import path (`@opencode-ai/sdk/v2`) is an implementation detail
  inside the adapter. If the SDK restructures its exports, only this package
  changes.

## Alternatives Considered

1. **Use v1 SDK with prompt injection for structured output**: Rejected because
   the TODO explicitly requested native structured output via `format`, and
   v1's types do not expose that field.
2. **Call `adapter.dispose()` from the conductor**: Rejected because it would
   leak the "embedded server" concept into core. The conductor should only
   know about per-session disposal.
