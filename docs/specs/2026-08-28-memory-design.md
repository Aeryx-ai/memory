# memory: one OKF bundle for every harness

Status: draft (design approved 2026-08-28, pending spec review). Supersedes the memory half of pi-extensions' `docs/specs/2026-07-19-pi-memory-and-profiles-design.md`.

Companion artifacts: [context map](memory-context-map.md), [domain model](memory-domain-model.md), [ADR 1](../adr/0001-adopt-okf-for-shared-agent-memory.md).

## Goal

One memory store every coding agent on every machine reads and writes the same way. Replace three pi extensions (`@guygrigsby/pi-claude-memory`, `pi-memory`, `pi-observational-memory`) with one, add a Claude Code plugin on the same store, migrate every existing memory into it idempotently.

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

A Session Summary is a concept of type `Session Summary`: one file per compaction, exit, or migrated daily-log day, `generated.by` the harness actor, `sources[].resource` the session id. One file per event means concurrent sessions never contend on a shared file.

## Package

Repo `github.com/aeryxai/memory` (org to be created; the handle does not exist on GitHub yet), checked out at `~/projects/memory`. The repo root is the npm package `@aeryx/memory`: library, the `memory` CLI (`bin`) and the pi extension (`pi.extensions`) in one package, so lib and CLI can never drift apart. `claude-plugin/` in the same repo is the Claude Code plugin, with a `.claude-plugin/marketplace.json` at the repo root so `claude plugin marketplace add aeryxai/memory` installs it; the guygrigsby marketplace can point at it too. `pi-extensions/claude-memory` is deleted once this ships. Dependencies: `yaml` for frontmatter, `git` on PATH. No database, no daemon.

## CLI contract

Agent-facing: JSON to stdout by default, `--md` for markdown, exit codes the caller branches on (0 ok, 1 usage, 2 not found, 3 refused by invariant, 4 check failed, 5 sync failed). Every command takes `--dir`.

| Command | Does |
| --- | --- |
| `init` | create the bundle, `git init`, root `index.md` with `okf_version` |
| `project-id [--cwd]` | print the project id for a working directory |
| `remember --type T --title X [--description] [--tags a,b] [--source R]... [--actor A] [--cwd] [--status draft]` | body on stdin; create or revise a concept; regen index; append log; commit; background push |
| `deprecate <slug\|path>` / `restore <slug\|path>` | status change, index, log, commit |
| `recall [--type T] [--cwd] [--deprecated] [query]` | term match over title, description, tags, body, ranked; root plus project by default |
| `show <slug\|path>` | one concept, frontmatter and body |
| `summarize --actor A --source R [--cwd] [--summarize-cmd CMD]` | body on stdin (or stdin piped through CMD, which must print the summary); writes a Session Summary |
| `context [--cwd] [--summaries 3] [--budget bytes]` | the bytes a harness injects: root index, project index, latest N Session Summary bodies; deterministic for the same bundle state so prefix caches hold |
| `index` | regenerate every `index.md` |
| `check` | every non-reserved `.md` parses, `type` legal for its directory, no secrets, every index matches regeneration; exit 4 on any failure |
| `sync [--pull\|--push]` | commit pending, `pull --rebase`, regen index if the pull changed anything, push |
| `migrate <claude\|hermes\|pi-memory\|codex\|all> [--dry-run]` | import legacy stores, idempotent |
| `doctor` | bundle present, remote set, `check` clean, Claude `autoMemoryEnabled` still on, legacy pi packages still installed |

Actor defaults to `human:$USER` when not passed; adapters always pass one. Concurrency: concepts and indexes are written temp-then-rename; git operations serialize on a lock directory inside the bundle with a stale timeout. A rebase conflict on a concept file aborts the rebase, exits 5, and `doctor` reports it until resolved by hand; a conflict on a generated file is resolved by regeneration.

## pi extension

Registered by the package's `pi.extensions` entry.

- `session_start`: background `memory sync --pull` capped at 5s, then snapshot `memory context`.
- `before_agent_start`: append the snapshot inside `<memory-context bundle=… project=…>` plus a two-line note naming the tools. The snapshot refreshes only after a memory tool writes, after compaction, and on day rollover, so the prefix stays byte-stable between.
- Tools `memory_remember`, `memory_recall`, `memory_deprecate`, `memory_summarize`, actor `pi/<model id>`.
- `session_compact`: pi's compaction summary becomes a Session Summary, no extra model call.
- `session_shutdown`: exit summary via one `complete` call on `settings["memory"].summaryModel` (default: session model), 10s cap, `MEMORY_EXIT_SUMMARY=off` disables.
- Commands `/memory` (doctor), `/memory recall <q>`, `/memory sync`.

## Claude Code plugin

`claude-plugin/` in the memory repo. Requires `npm i -g @aeryx/memory`; `doctor` says so when the binary is missing.

- `SessionStart` (startup, resume, clear, compact): `memory sync --pull` then `memory context --md` as `additionalContext`, followed by the usage note (remember with `memory remember …` through Bash, recall with `memory recall`).
- `PreCompact` and `SessionEnd`: hook script extracts the transcript tail from `transcript_path` and pipes it to `memory summarize --actor claude-code/<model> --source claude-code:session/<id> --summarize-cmd "claude -p --model claude-haiku-4-5-20251001 <prompt>"`. Same OAuth, no key. Timeout 120s. Whether `claude -p` runs cleanly inside a hook is the first thing the plan verifies.
- Skill `memory`: the four-kind guidance the harness uses today, restated against the CLI, with the placement rules.
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

Every write commits. Push runs detached after each write; pull runs once per session start. Both are best effort with caps and never block a turn. The bundle's remote is a private repo; `init --remote <url>` sets it, `doctor` nags when it is absent. Event driven, no cron.

## What was missing from the ask

- Secret refusal on every write (Codex and hermes both do it; the Telegram token rule needs it).
- Concurrency: many sessions, harnesses and machines writing at once; solved by one file per concept, atomic writes, generated indexes, rebase.
- Cross-machine sync; without it memory stays per-box.
- A conformance check that doubles as the drift guard for generated indexes.
- Retirement: uninstall the three pi packages, turn off Claude auto memory, leave legacy dirs in place until the migration report is clean.
- `~/.agents/AGENTS.md` pointer so a harness with no adapter (Codex, opencode) can still use the CLI.
- Session Summary retention: keep forever, inject the latest three. Revisit if a project directory grows past a few hundred.
- Subagents get no context injection; a pi subagent or Claude subagent that needs memory calls `memory recall`.

## Tests

`node:test` over the library: frontmatter round trip, slug, project id, actor, index and log rendering, secret scanner, every importer against fixture copies of the real legacy formats. CLI end to end in a temp bundle with `git init`. `memory check` runs in `make test`. Plugin hook scripts run against a temp bundle from the same `npm test`. The pi extension's core is import-free `.mjs` under test, the pattern the pi-extensions packages use; hook wiring is verified by launching pi against a temp bundle.

## Out of scope

Codex and opencode adapters (the CLI and `~/.agents/AGENTS.md` cover them until scheduled). Semantic search (`recall` is term ranking; a qmd adapter can follow). Consolidation or dreaming passes. An MCP surface.
