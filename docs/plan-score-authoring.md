# Plan: Natural-language score authoring in the Pi plugin

## Scope

- `packages/plugin-pi` only.
- Add score management tools to the Pi plugin extension.
- Add an `orchestron-score-authoring` skill included in the package.
- No CLI commands; no opencode plugin changes in this pass.

## New tools

| Tool | Parameters | Behavior |
|---|---|---|
| `orchestron_create_score` | `scoreId`, `yaml`, `persist?`, `saveLocation?` | Parse YAML, validate, register in `ScoreRegistry`. If `persist: true`, save to disk. |
| `orchestron_edit_score` | `scoreId`, `yaml`, `persist?`, `saveLocation?` | Parse YAML, validate, update `ScoreRegistry`. If `persist: true`, overwrite the file. |
| `orchestron_get_score` | `scoreId` | Return the full YAML and file path of an existing score. |

- `persist` defaults to `false`.
- `saveLocation` defaults to `local` (`./.orchestron/scores/`); `global` maps to `~/.orchestron/scores/`.
- Scores are validated before any write or in-memory registration.
- `orchestron_list_scores` will include a `persisted: boolean` field.

## Workflow this enables

1. User: *"Create a score that analyzes a topic and summarizes it."*
2. Model generates YAML and calls `orchestron_create_score(scoreId, yaml, persist: false)`.
3. User: *"Run it with topic='AI agents' to test it."*
4. Model calls `orchestron_start_concert(scoreId)` — the in-memory score is executable.
5. User: *"Save it."*
6. Model calls `orchestron_create_score(scoreId, yaml, persist: true)` (or `orchestron_edit_score`) to write the file.

## Score ID sanitization

- `scoreId` must be safe for filenames.
- Enforce: lowercase letters, numbers, hyphens, underscores only.
- Reject IDs that do not sanitize cleanly.
- Filename: `<sanitized-scoreId>.score.yaml`.
- The YAML's `id` field must match the sanitized `scoreId`.

## Files to create

- `packages/plugin-pi/src/tools/_score-helpers.ts`
- `packages/plugin-pi/src/tools/create-score.ts`
- `packages/plugin-pi/src/tools/edit-score.ts`
- `packages/plugin-pi/src/tools/get-score.ts`
- `packages/plugin-pi/src/tools/validate-score.ts`
- `packages/plugin-pi/src/__tests__/score-tools.test.ts`
- `packages/plugin-pi/skills/orchestron-score-authoring/SKILL.md`

## Files to modify

- `packages/plugin-pi/src/index.ts` — register new tools.
- `packages/plugin-pi/src/orchestron.ts` — expose `scoresDirs` in the `Orchestron` interface.
- `packages/plugin-pi/src/tools/list-scores.ts` — add `persisted` flag.
- `packages/plugin-pi/package.json` — add `js-yaml` + `@types/js-yaml`, add `pi.skills` manifest.
- `packages/plugin-pi/README.md` — document new tools and skill.
- `packages/plugin-pi/examples/prompts.md` — add example prompts.

## Development symlink for the skill

```bash
mkdir -p .pi/skills
ln -s /Users/craig/Code/sleekslush/orchestron/packages/plugin-pi/skills/orchestron-score-authoring \
  .pi/skills/orchestron-score-authoring
```

Pi will auto-discover the skill from `./.pi/skills/`.

## Tests

- Create valid score with `persist: true` → saved and registered.
- Create valid score with `persist: false` → registered, not saved.
- Create invalid score → not saved and not registered.
- Create duplicate score ID → error.
- Edit existing score with `persist: true` → file updated and re-registered.
- Edit with `persist: false` → registry updated, file unchanged.
- Edit with invalid YAML → file unchanged.
- Get score → returns YAML and path.
- Validate score → returns validation status.
- Run in-memory-only score via `orchestron_start_concert`.
- List scores shows correct `persisted` flag.

## Status

Implemented. All tests and typecheck pass.

## Notes

- In-memory-only scores are lost when the Pi session/plugin restarts.
- If a score exists in memory and on disk, the in-memory version wins for the current session.
- No explicit "discard" tool in the first version; the user can overwrite or restart.

