# memory: one OKF bundle for every harness

Status: draft (design approved 2026-08-28, pending spec review). Supersedes the memory half of pi-extensions' `docs/specs/2026-07-19-pi-memory-and-profiles-design.md`.

Companion artifacts: [context map](memory-context-map.md), [domain model](memory-domain-model.md), [ADR 1](../adr/0001-adopt-okf-for-shared-agent-memory.md).

## Goal

One memory store every coding agent on every machine reads and writes the same way, and fast: no turn ever waits on memory. Replace three pi extensions (`@guygrigsby/pi-claude-memory`, `pi-memory`, `pi-observational-memory`) with one, add a Claude Code plugin on the same store, migrate every existing memory into it idempotently.

## Standard

The store is an [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle. OKF terms are used verbatim: bundle, concept, `type`, `index.md`, `log.md`, `generated`, `verified`, `status`, `stale_after`, `sources`, `tags`, actor. Nothing is renamed. Additions, all permitted by the spec's extension and free-form `type` rules:

| Addition | Why OKF does not cover it |
| --- | --- |
| `projects/<project id>/` directory convention | OKF fixes no hierarchy; harnesses need per-repo concepts |
| Type vocabulary `User`, `Feedback`, `Project`, `Reference`, `Session Summary` | OKF leaves types to the producer |
| Secret refusal at write | OKF has no content policy |
| Directory placement rules per type | OKF has no placement rules |

## Layout

Bundle at `~/.agents/memory` (`MEMORY_DIR` overrides), a private git repo. `~/.agents/` is the cross-agent home dir already used for skills; the dotagents proposal names `memory/` under it.

```
index.md                       generated, carries okf_version: "0.2"
log.md                         OKF §9 change log, appended on every write
user/<slug>.md                 type: User
feedback/<slug>.md             type: Feedback
reference/<slug>.md            type: Reference
session-summaries/<stamp>.md   type: Session Summary
projects/github.com/guygrigsby/pi-extensions/
  index.md  log.md
  project/<slug>.md  feedback/<slug>.md  reference/<slug>.md  session-summaries/<stamp>.md
```

Placement: `User` at the root only, `Project` under a project only, the rest at either level. A project id comes from the git origin (`git@github.com:guygrigsby/x.git` becomes `github.com/guygrigsby/x`) so it matches across machines; a repo with no remote gets `local/<repo basename>`.

## Concept

```yaml
---
type: Feedback
title: Reminders via Telegram
description: "remind me" means a scheduled job that does the check and Telegrams the result
tags: [telegram]
status: stable
generated: { by: claude-code/claude-fable-5, at: 2026-08-28T20:15:00Z }
sources:
  - { resource: "claude-code:session/28c669b5-b40a-4de7-979c-ad9ac9ed1b46" }
---
Body in markdown. Links to other concepts are bundle-relative: [op cache](/feedback/secrets-from-op-cache.md).
```

The CLI is the only writer. It refuses (nothing written, exit 3) a type outside the vocabulary, an illegal type for the directory, an empty title, a malformed actor, or a secret pattern in title, description or body. Slug derives from the title; writing the same slug in the same directory revises the concept in place and bumps `generated.at`. Forgetting is `status: deprecated`; deprecated concepts leave the index and the context render, stay on disk, and `restore` returns them to `stable`. Git history is the recovery path, no recovery directory.

`index.md` per directory is generated from frontmatter, grouped by type in OKF §8 form, never hand-edited. `log.md` per directory is appended in OKF §9 form (`## YYYY-MM-DD`, `* **Creation**` / `**Update**` / `**Deprecation**`).

A Session Summary is a concept of type `Session Summary`: one per session (or per migrated daily-log day), `generated.by` the harness actor, `sources[].resource` the session id. It is `draft` while the session lives and revised in place by background folds, `stable` once the session ends. One file per session means concurrent sessions never contend on a shared file.

## Speed

The three extensions being replaced are slow for the same reasons: model calls on the hot path (observer and reflector passes, background reviews every N turns, a blocking exit summary), a search index rebuilt after every write, and per-turn context rebuilds that bust the prefix cache. This design has none of them.

- Read path: `context` reads two `index.md` files and N summary files already on disk. No model, no database, no network. Budget 20ms.
- Write path: `remember` writes one file temp-then-rename, appends one line to `log.md` and returns. Budget 30ms. Index regeneration, git commit and push run in one detached background process spawned by the write; the caller never waits.
- Concurrency: concept writes never lock; each is its own file, and two writers to the same slug are last-writer-wins, no merge. Only git operations take the lock, and a background job that finds it held exits instead of waiting: the next write's job commits everything pending with `git add -A`.
- Drop policy: a lost background job means a stale index or an uncommitted concept, never a corrupt file. `check` finds it; the next write or `index` repairs it. Memory is not a ledger; losing one summary is acceptable, waiting on one is not.
- Model calls happen only in background folds of the running summary (below), each over a small transcript delta on a cheap model, detached, so the harness never waits for them. Nothing runs on a timer.
- Session start: pull runs detached; the context snapshot is taken from local state immediately. A pull that lands mid-session shows up next session.
- Prefix cache: the injected block is byte-stable within a session except after a memory tool write or a compaction.

## Running summary

Each session keeps one Session Summary concept current in the background, so compaction and exit have nothing left to compute. The body has two conventional headings, and a fold never re-summarizes a summary:

```markdown
# Reflections
[b2c3d4e5f6a1] Hard constraint: memory writes never block a turn.

# Observations
[d4e5f6a1b2c3] 2026-08-29 10:53 [high] User chose OKF v0.2 over a custom format; wants OKF terms verbatim.
[e5f6a1b2c3d4] 2026-08-29 11:02 [medium] Adopted append-only observations plus distilled reflections for Session Summaries.
```

- Observations: append-only, timestamped, 12-hex id, relevance `low|medium|high|critical`, and the source entry ids they came from (kept in the concept's `sources[]`, one entry per observation id, `resource` the transcript entry ids). Never rewritten.
- Reflections: durable facts distilled from observations, each carrying the observation ids that support it. Revised only when the observation pool crosses its size.
- Pruning is mechanical: past `observationsMaxTokens` (20k default) drop observations covered by a reflection first, then lowest relevance oldest first, to `observationsTargetTokens` (10k). No model.
- Trigger: after each turn (pi `agent_settled`, Claude Code `Stop` with `async: true`) the adapter runs `memory fold --session <resource> --transcript <path>`, which compares transcript bytes against the session's checkpoint under `<bundle>/.state/` (gitignored). Below `observeAfterTokens` (8k) it exits at once. At or above it, it spawns a detached job and exits.
- Fold job: single-flight per session (lock held means skip). Reads only the transcript delta since the checkpoint, sends it with the current reflections and recent observations through the summarizer (`claude -p` on haiku, `pi -p` on `settings["memory"].summaryModel`) with a fixed observer prompt, appends the returned observations, advances the checkpoint. When observations since the last reflection exceed `reflectAfterTokens` (20k) the same job runs the reflector prompt once and rewrites the Reflections section. Two prompts, both on a delta, never on a turn.
- `observeAfterTokens` sits below the harness's kept-recent window (pi `keepRecentTokens` 20k), which guarantees the unfolded tail is still inside the messages compaction keeps verbatim. Summary plus kept messages cover the whole session with no synchronous fold.
- pi compaction: `session_before_compact` returns `{ summary: <rendered Reflections and Observations>, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore }`. No model call; compaction is a file read. `/compact <instructions>` falls through to pi's own compaction when instructions are given.
- Claude Code compaction: native compaction cannot be replaced. `PreCompact` returns `compactionInstructions` that point at the running summary and ask the native pass to cover only the recent turns; `SessionStart` with trigger `compact` injects the running summary first, so post-compaction context is ours regardless of what native compaction kept.
- Recall: `memory recall-observation <id>` returns the source transcript entries behind an observation or reflection, from the pi session file or the Claude transcript named in the concept's `sources[]`. Exposed as a tool in pi and through the skill in Claude Code.
- Exit: `session_shutdown` and `SessionEnd` (1.5s budget) spawn a detached final fold with `--finalize`, which sets `status: stable`. Resume of the same session id reopens the same concept.

Rendering into `context` uses the same two sections, reflections first. A migrated pi-memory daily log has observations only.

Trust boundary. Transcript text (tool results, fetched pages, file contents) reaches the observer model and its output lines become observations that every later session in the project receives as context. Text the agent read becomes text the agent later believes, laundered through the summarizer. What bounds it: tool results are clipped before they reach the prompt, cited entry ids must exist in the delta, observation and reflection lines run through the secret scanner, observation content is capped at 240 characters, one fold adds at most 40 observations, and the `<memory-context>` header states that the block is recorded memory, not instructions. What does not bound it: the model can still be steered into writing a false or manipulative observation. Consumers treat Session Summaries as evidence of what happened, never as directives.

## Package

Repo `github.com/aeryx-ai/memory` (org to be created; the handle does not exist on GitHub yet), checked out at `~/projects/memory`. The repo root is the npm package `@aeryx/memory`: library, the `memory` CLI (`bin`) and the pi extension (`pi.extensions`) in one package, so lib and CLI can never drift apart. `claude-plugin/` in the same repo is the Claude Code plugin, with a `.claude-plugin/marketplace.json` at the repo root so `claude plugin marketplace add aeryx-ai/memory` installs it; the guygrigsby marketplace can point at it too. `pi-extensions/claude-memory` is deleted once this ships. Dependencies: `yaml` for frontmatter, `git` on PATH. No database, no daemon.

## CLI contract

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
| `context [--cwd] [--session R] [--summaries 3] [--budget bytes]` | the bytes a harness injects: root index, project index, latest N Session Summary bodies, the current session's own summary first when `--session` is given; deterministic for the same bundle state so prefix caches hold |
| `index` | regenerate every `index.md` |
| `check` | every non-reserved `.md` parses, `type` legal for its directory, no secrets, every index matches regeneration; exit 4 on any failure |
| `sync [--pull\|--push]` | commit pending, `pull --rebase`, regen index if the pull changed anything, push; exits at once if the lock is held |
| `migrate <claude\|hermes\|pi-memory\|codex\|all> [--dry-run]` | import legacy stores, idempotent |
| `doctor` | bundle present, remote set, `check` clean, Claude `autoMemoryEnabled` still on, legacy pi packages still installed |

Actor defaults to `human:$USER` when not passed; adapters always pass one. Concepts and indexes are written temp-then-rename; git operations serialize on a lock directory inside the bundle with a stale timeout, and a job that finds it held exits. A rebase conflict on a concept file aborts the rebase, exits 5, and `doctor` reports it until resolved by hand; a conflict on a generated file is resolved by regeneration.

## pi extension

Registered by the package's `pi.extensions` entry.

- `session_start`: spawn detached `memory sync --pull`; snapshot `memory context` from local state at once.
- `before_agent_start`: append the snapshot inside `<memory-context bundle=… project=…>` plus a two-line note naming the tools. The snapshot refreshes only after a memory tool writes, after compaction, and on day rollover, so the prefix stays byte-stable between.
- Tools `memory_remember`, `memory_recall`, `memory_deprecate`, `memory_recall_observation`, actor `pi/<model id>`.
- `agent_settled`: `memory fold` with the session file as transcript; returns in milliseconds, folds detach.
- `session_before_compact`: return the running summary as the compaction result; no model call.
- `session_shutdown`: `memory fold --finalize`, detached; quit does not wait. `MEMORY_FOLD=off` disables folding entirely.
- Commands `/memory` (doctor), `/memory recall <q>`, `/memory sync`.

## Claude Code plugin

`claude-plugin/` in the memory repo. Requires `npm i -g @aeryx/memory`; `doctor` says so when the binary is missing.

- `SessionStart` (startup, resume, clear, compact): spawn detached `memory sync --pull`, print `memory context --session <id> --budget 200000` as `additionalContext`, followed by the usage note (remember with `memory remember …` through Bash, recall with `memory recall`).
- `Stop` (`async: true`): `memory fold --session claude-code:session/<id> --transcript <transcript_path> --summarize-cmd "claude -p --model claude-haiku-4-5-20251001"`. Same OAuth, no key. Whether a detached `claude -p` completes after the hook exits is the first thing the plan verifies.
- `PreCompact`: emit `compactionInstructions` naming the running summary and limiting the native pass to recent turns.
- `SessionStart` with trigger `compact`: `memory context --session <id>` so the running summary leads the post-compaction context.
- `SessionEnd`: `memory fold --finalize`, detached, inside the 1.5s budget.
- Skill `memory`: the four-kind guidance the harness uses today, restated against the CLI, with the placement rules and `recall-observation` for expanding a summary line.
- Command `/memory`: doctor, recall.
- README: set `"autoMemoryEnabled": false` in `~/.claude/settings.json`. Native auto memory stays available but unused; the plugin does not depend on it.

## Migration

`memory migrate`, idempotent on `sources[].resource` with `sources[].last_modified` from the legacy file's mtime; a rerun skips unchanged sources and revises concepts whose source is newer. Never deletes or edits a legacy file. `--dry-run` prints the plan. Every imported concept carries `generated.by: process:migrate-<store>`.

| Store | From | To |
| --- | --- | --- |
| claude | `~/.claude/projects/*/memory/*.md` except `MEMORY.md` | slug dir decoded to a path, path to project id; `metadata.type` to `type`; `name` to slug; `[[link]]` to bundle-relative markdown link where the target exists |
| hermes | `~/.pi/agent/pi-hermes-memory/{MEMORY,USER,failures}.md`, split on `§`, `created`/`last` comments to `generated.at`/`last_modified` | root `Feedback`, `User`, `Feedback`; title from the first clause |
| hermes projects | `~/.pi/agent/projects-memory/<name>/MEMORY.md` | `Project` under the id of `~/projects/<name>` when it exists, else `local/<name>` |
| pi-memory | `~/.pi/agent/memory/daily/*.md` | one root Session Summary per day |
| codex | `~/.codex/memories/*.md` | one `Project` concept per file, project resolved by basename under `~/projects` |

Hermes `skills/` are skills, not memory: reported, not imported. Hermes root `MEMORY.md` entries land as `Feedback`; some are really `Project`, retagging is a later pass. `make migrate` runs `migrate all`; `doctor` then lists the three pi packages to uninstall.

## Sync across machines

Every write's detached job commits and pushes. Pull runs detached once per session start. All best effort; none blocks a turn. The bundle's remote is a private repo; `init --remote <url>` sets it, `doctor` nags when it is absent. Event driven, no cron.

## What was missing from the ask

- Secret refusal on every write (Codex and hermes both do it; the Telegram token rule needs it).
- Concurrency: many sessions, harnesses and machines writing at once; solved by one file per concept, atomic writes, generated indexes, rebase.
- Cross-machine sync; without it memory stays per-box.
- A conformance check that doubles as the drift guard for generated indexes.
- Retirement: uninstall the three pi packages, turn off Claude auto memory, leave legacy dirs in place until the migration report is clean.
- `~/.agents/AGENTS.md` pointer so a harness with no adapter (Codex, opencode) can still use the CLI.
- Session Summary retention: keep forever, inject the latest three. Revisit if a project directory grows past a few hundred.
- Fold settings: `observeAfterTokens` 8k, `reflectAfterTokens` 20k, `observationsMaxTokens` 20k, `observationsTargetTokens` 10k, `summaryModel`. Same knobs OM exposed, same defaults except the observe threshold, which must stay under the kept window.
- Fold state (`.state/`) is per machine and gitignored; a session resumed on another machine starts a fresh checkpoint against the same concept.
- Subagents get no context injection; a pi subagent or Claude subagent that needs memory calls `memory recall`.

## Tests

`node:test` over the library: frontmatter round trip, slug, project id, actor, index and log rendering, secret scanner, every importer against fixture copies of the real legacy formats. CLI end to end in a temp bundle with `git init`. `memory check` runs in `make test`. Plugin hook scripts run against a temp bundle from the same `npm test`. The pi extension's core is import-free `.mjs` under test, the pattern the pi-extensions packages use; hook wiring is verified by launching pi against a temp bundle.

## Out of scope

Codex and opencode adapters (the CLI and `~/.agents/AGENTS.md` cover them until scheduled). Semantic search (`recall` is term ranking; a qmd adapter can follow). Consolidation or dreaming passes. An MCP surface.
