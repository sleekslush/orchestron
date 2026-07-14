# @orchestron/plugin-pi

Pi session plugin for Orchestron. Lets you start, monitor, pause, cancel, and
author Orchestron scores directly from a Pi session using natural language.

## Tools

The plugin registers these Pi tools:

### Concerts

- `orchestron_start_concert(scoreId, context?)` — Start a new concert from a
  registered score. Runs in the background so the Pi session can continue.
- `orchestron_get_concert_status(concertId)` — Show status, movement history,
  and resource usage for a concert.
- `orchestron_list_concerts(filter?)` — List concerts, optionally filtered by
  status.
- `orchestron_pause_concert(concertId)` — Pause a running concert.
- `orchestron_cancel_concert(concertId)` — Cancel a running or paused concert.
- `orchestron_wait_for_concert(concertId)` — Block until a concert reaches a
  terminal state. Streams progress updates in real time.

### Scores

- `orchestron_list_scores()` — List registered scores and whether each is
  persisted to disk.
- `orchestron_get_score(scoreId)` — Get the full YAML of a score.
- `orchestron_create_score(scoreId, yaml, persist?, saveLocation?)` — Create a
  new score from YAML. Set `persist: true` to save it.
- `orchestron_edit_score(scoreId, yaml, persist?, saveLocation?)` — Replace an
  existing score with new YAML.

All tools return structured JSON so Pi can summarize the results for the user.

## Natural language score authoring

Use the `orchestron-score-authoring` skill. The SDK does not generate YAML; it
validates, reads, and writes files. The model generates the YAML based on the
skill instructions and tool descriptions.

Typical workflow:

1. User: *"Create a score that analyzes a topic and summarizes it."*
2. Model generates YAML and calls `orchestron_create_score(scoreId, yaml, persist: false)`.
3. User: *"Run it with topic='AI agents' to test."*
4. Model calls `orchestron_start_concert(scoreId)`.
5. User: *"Save it."*
6. Model calls `orchestron_create_score(scoreId, yaml, persist: true)`.

## Usage

Load the plugin from the monorepo:

```bash
pi -e ./packages/plugin-pi/orchestron/index.ts
```

Or install it as a local Pi package (for development):

```bash
pi install ./packages/plugin-pi
```

Or install it as a Pi package from npm (once published):

```bash
pi install npm:@orchestron/plugin-pi
```

To use the score-authoring skill during development, symlink it into the
project-local skills directory:

```bash
mkdir -p .pi/skills
ln -s /path/to/orchestron/packages/plugin-pi/skills/orchestron-score-authoring \
  .pi/skills/orchestron-score-authoring
```

**Note:** When using `pi install ./packages/plugin-pi`, the skill is automatically
discovered if the package includes a `pi.skills` manifest. The plugin includes
this, so the skill should be available without manual symlinking.

Then ask Pi:

```
Run the jira-to-mr workflow for PROJ-123
```

or:

```
Create a score that analyzes a topic and summarizes it.
```

## Configuration

The plugin uses the same defaults as the Orchestron CLI:

- Store: `~/.orchestron/store.db`
- Scores: `./.orchestron/scores/` (project-local) and `~/.orchestron/scores/`
  (global)

Override with environment variables:

```bash
ORCHESTRON_STORE_PATH=/path/to/store.db ORCHESTRON_SCORES_DIRS=/path/to/scores pi -e ./packages/plugin-pi/orchestron/index.ts
```
