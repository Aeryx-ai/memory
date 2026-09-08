# memory

One [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle every coding agent reads and writes the same way: a CLI, a pi extension and a Claude Code plugin, backed by one git-synced directory of markdown concepts. No turn ever waits on it.

## Install

pi:

```
pi install npm:@aeryx/memory
```

Claude Code:

```
npm i -g @aeryx/memory
claude plugin marketplace add aeryx-ai/memory
claude plugin install memory@aeryx
```

then set `"autoMemoryEnabled": false` in `~/.claude/settings.json` so native auto memory and this plugin do not fight. See `claude-plugin/README.md` for what each hook does.

## Go SDK

`memory-go/` is a Go module with the same bundle contract, byte compatible with the CLI and proven by golden tests generated from the CLI. See `memory-go/README.md`.

## Set up the bundle

```
memory init --remote <private bundle repo url>
```

Creates `~/.agents/memory` (or `MEMORY_DIR`), `git init`s it, points it at the private remote and writes the root `index.md`. Every write's background job pushes; `memory sync --pull` runs once per session start.

## Migrate from the old extensions

memory replaces `@guygrigsby/pi-claude-memory`, `pi-memory` and `pi-observational-memory`. Preview first, then run for real:

```
memory migrate all --dry-run
memory migrate all
memory check
memory doctor
```

(`make migrate` runs `migrate all`.) Imports are idempotent and safe to rerun; they never edit or delete the legacy files. Once `doctor` reports clean, retire the old stack:

```
pi remove npm:@guygrigsby/pi-claude-memory npm:pi-memory npm:pi-observational-memory
```

and set `"autoMemoryEnabled": false` in `~/.claude/settings.json` if the plugin install did not already.

## CLI

Agent-facing: JSON to stdout by default, `--md` for markdown, exit codes the caller branches on (0 ok, 1 usage, 2 not found, 3 refused by invariant, 4 check failed, 5 sync failed). Every command takes `--dir`.

| Command | Does |
| --- | --- |
| `init` | create the bundle, `git init`, root `index.md` with `okf_version` |
| `project-id [--cwd]` | print the project id for a working directory |
| `remember --type T --title X [--description] [--tags a,b] [--source R]... [--actor A] [--cwd] [--status draft]` | body on stdin; write the concept and return; index, log, commit and push follow in a detached job |
| `deprecate <slug\|path>` / `restore <slug\|path>` | rewrite status and return; index, log, commit in the detached job |
| `recall [--type T] [--cwd] [--deprecated] [query]` | term match over title, description, tags, body, ranked; root plus project by default |
| `show <slug\|path>` | one concept, frontmatter and body |
| `fold --session R --actor A --transcript PATH [--cwd] [--finalize] [--summarize-cmd CMD]` | checkpoint compare; below `observeAfterTokens` exit 0; else detach a job that appends observations from the delta, reflects when due, prunes, advances the checkpoint; `--finalize` folds whatever is left and marks it `stable` |
| `recall-observation <id>` | the source transcript entries behind one observation or reflection id |
| `summarize --session R --actor A [--cwd]` | body on stdin becomes the session's Session Summary verbatim (pi compaction summaries, migration) |
| `context [--cwd] [--session R] [--summaries 3] [--budget bytes]` | the bytes a harness injects: root index, project index, latest N Session Summary bodies, the current session's own summary first when `--session` is given; deterministic for the same bundle state so prefix caches hold; always plain text, not JSON, regardless of `--md` |
| `index` | regenerate every `index.md` |
| `check` | every non-reserved `.md` parses, `type` legal for its directory, no secrets, every index matches regeneration; exit 4 on any failure |
| `sync [--pull\|--push]` | commit pending, `pull --rebase`, regen index if the pull changed anything, push; exits at once if the lock is held |
| `migrate <claude\|hermes\|pi-memory\|codex\|all> [--dry-run]` | import legacy stores, idempotent |
| `doctor` | bundle present, remote set, `check` clean, Claude `autoMemoryEnabled` still on, legacy pi packages still installed |

Actor defaults to `human:$USER` when not passed; the pi and Claude adapters always pass one.

## Settings

pi reads a `"memory"` block from `~/.pi/agent/settings.json` (or `<cwd>/.pi/settings.json`, merged over it):

- `dir`: bundle root, overrides `MEMORY_DIR`.
- `summaryModel`: model the fold job's summarizer runs on, `pi/<model id>` by default.
- `observeAfterTokens` (default 8000), `reflectAfterTokens` (20000), `observationsMaxTokens` (20000), `observationsTargetTokens` (10000), `observerMaxTokens` (60000, caps the delta handed to the observer prompt itself): fold thresholds, see Speed below.

## Environment variables

- `MEMORY_DIR`: bundle root, default `~/.agents/memory`.
- `MEMORY=off`: disables the pi extension entirely and gates the Claude Code hooks off, so a nested `claude -p` summarizer call cannot recurse into its own hooks.
- `MEMORY_FOLD=off`: disables background folding (pi and Claude) without disabling context injection or the memory tools.
- `MEMORY_SUMMARIZE_CMD`: overrides the Claude plugin's summarizer command (default `MEMORY=off claude -p --model claude-haiku-4-5-20251001 --output-format text`; `MEMORY=off` is there so the nested `claude -p` does not run these hooks itself).
- `MEMORY_BIN`: overrides the `memory` binary the Claude plugin hooks call, for pointing tests or a local checkout at `node <repo>/bin/memory.mjs` instead of a global install.

## Speed

No turn waits on memory. `context` reads two `index.md` files and a few summary files already on disk: no model, no database, no network, budget 20ms. `remember` writes one file and appends one log line, budget 30ms; index regeneration, `git commit` and `git push` run in a detached background process the caller never waits for. Concept writes never lock; two writers to the same slug are last-writer-wins. A lost background job leaves a stale index or an uncommitted concept, never a corrupt file: `check` finds it, the next write or `memory index` repairs it. The only model calls happen in background folds of the running session summary, over a small transcript delta, on a cheap model, detached; nothing runs on a timer.

## Layout

Bundle at `~/.agents/memory`, a private git repo: `index.md` and `log.md` at the root and per project; `user/`, `feedback/`, `reference/` and `session-summaries/` directories; `projects/<project id>/` for per-repo concepts. Full design in `docs/specs/2026-08-28-memory-design.md`.
