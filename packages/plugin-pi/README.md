# @orchestron/plugin-pi

Pi session plugin for Orchestron. Lets you start, monitor, pause, and cancel
Orchestron concerts directly from a Pi session using natural language.

## Tools

The plugin registers these Pi tools:

- `orchestron_start_concert(scoreId, context?)` — Start a new concert from a
  registered score. Runs in the background so the Pi session can continue.
- `orchestron_get_concert_status(concertId)` — Show status, movement history,
  and resource usage for a concert.
- `orchestron_list_concerts(filter?)` — List concerts, optionally filtered by
  status.
- `orchestron_pause_concert(concertId)` — Pause a running concert.
- `orchestron_cancel_concert(concertId)` — Cancel a running or paused concert.
- `orchestron_list_scores()` — List all registered scores and their movements.

All tools return structured JSON so Pi can summarize the results for the user.

## Usage

Load the plugin from the monorepo:

```bash
pi -e ./packages/plugin-pi/src/index.ts
```

Or install it as a Pi package (once published):

```bash
pi install npm:@orchestron/plugin-pi
```

Then ask Pi:

```
Run the jira-to-mr workflow for PROJ-123
```

Pi will call `orchestron_start_concert`, get back a concert ID, and can check
status with `orchestron_get_concert_status` when you ask.

## Configuration

The plugin uses the same defaults as the Orchestron CLI:

- Store: `~/.orchestron/store.db`
- Scores: `./orchestron/scores/` (project-local) and `~/.orchestron/scores/`
  (global)

Override with environment variables:

```bash
ORCHESTRON_STORE_PATH=/path/to/store.db ORCHESTRON_SCORES_DIRS=/path/to/scores pi -e ./packages/plugin-pi/src/index.ts
```
