# @orchestron/plugin-opencode

Opencode session plugin for Orchestron. Lets you start, monitor, pause, cancel, and
author Orchestron scores directly from an opencode session using natural language.

## Tools

### Concerts

- `orchestron_start_concert(scoreId, context?)` — Start a new concert from a
  registered score. Runs in the background.
- `orchestron_get_concert_status(concertId)` — Show status, movement history,
  and resource usage for a concert.
- `orchestron_list_concerts(filter?)` — List concerts, optionally filtered by
  status.
- `orchestron_pause_concert(concertId)` — Pause a running concert.
- `orchestron_cancel_concert(concertId)` — Cancel a running or paused concert.
- `orchestron_wait_for_concert(concertId)` — Block until a concert reaches a
  terminal state. Returns the final status and movement history.

### Scores

- `orchestron_list_scores()` — List registered scores and whether each is
  persisted to disk.
- `orchestron_get_score(scoreId)` — Get the full YAML of a score.
- `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)` — Create a
  new score from YAML. Set `persist: true` to save it.
- `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)` — Replace an
  existing score with new YAML.

All tools return JSON strings that opencode can summarize.

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["@orchestron/plugin-opencode"]
}
```

Or symlink for local development:

```bash
mkdir -p .opencode/plugins
ln -s ../../packages/plugin-opencode .opencode/plugins/plugin-opencode
```

## Configuration

The plugin uses the same defaults as the Orchestron CLI:

- Store: `~/.orchestron/store.db`
- Scores: `./.orchestron/scores/` (project-local) and `~/.orchestron/scores/` (global)

Override with environment variables:

```bash
ORCHESTRON_STORE_PATH=/path/to/store.db ORCHESTRON_SCORES_DIRS=/path/to/scores
```
