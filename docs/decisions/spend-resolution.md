# Spend Resolution Across Providers

Date: 2026-08-01
Status: Accepted

## Context

Concert usage reporting showed `unknown` spend whenever the harness omitted a cost.
That was the common case: `pnpm orchestron list` reported `unknown / N tokens` for
every recent concert even though the store already persisted `model`, `provider`,
`inputTokens`, and `outputTokens` per movement, and OpenRouter publishes per-model
pricing publicly. Spend resolution was entirely delegated to each harness adapter's
reported cost, so any model newer than a harness's pricing index (e.g.
`deepseek/deepseek-v4-flash-0731`) left `spend` undefined.

## Decision

Introduce a cost-resolution layer (`packages/core/src/cost/`) that resolves spend at
read time (CLI `list`/`status` and aggregates) with a per-provider strategy and a
precedence order. A `CostResolver` walks:

1. **Measured** — harness-reported cost (source of truth, exact). Skipping estimation.
2. **Provider pricing** — OpenRouter's public `GET /api/v1/models` (`pricing.prompt` /
   `pricing.completion`, USD per token), with an in-memory TTL (24h) plus an on-disk
   cache (`~/.orchestron/pricing-cache.json`) so reads work offline after first fetch.
3. **Configured table** — `~/.orchestron/config.json` `pricing` overrides keyed by
   `provider`/`model` (most-specific first) for providers without a public pricing API
   (e.g. direct OpenAI/Anthropic keys).
4. **Free models** — `:free` suffix or zero pricing resolve to `$0.00` estimated.
5. **Nothing** → `unknown`, unchanged.

Each resolved figure is microdollars plus a `spendSource: 'measured' | 'estimated'`
field persisted inside the movement/concert `usage` JSON. `SystemAggregates` now
distinguishes `measuredSpend` / `estimatedSpend` so totals are never silently
conflated; the CLI renders estimated spend with a `~$` prefix.

Backfill: `SqliteLoge.backfillSpend` walks persisted movements that have tokens +
model/provider but no spend, resolves them, and folds the result into the owning
concert's usage. It is idempotent — movements that already carry spend are untouched.

Concert execution is never blocked on pricing: resolution happens only on read paths
(`list`/`status`/aggregates), never during a concert run.

## Out of scope (future work)

- Real-time per-request invoice reconciliation against OpenRouter's billing API
  (`/api/v1/auth/key`, generation endpoints) — a future audit command, not per-concert
  attribution.
- Splitting input tokens into cache-hit vs cache-miss. Cache-read tokens bill at
  `input_cache_read`, but we only persist aggregate input tokens, so estimated cost can
  overstate vs. an actual invoice when cache hits are heavy. We document this as an
  upper-bound estimate.
- Non-USD currency handling.
- Repo-maintained static price tables for OpenAI/Anthropic (config table covers it, and
  prices drift too fast for a checked-in table to stay honest).
