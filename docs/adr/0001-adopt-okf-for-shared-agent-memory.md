# 1. Adopt OKF for shared agent memory, CLI as the only writer

- **Status:** Proposed
- **Date:** 2026-08-28
- **Change size:** large (DDD applied)

## Context

Three pi extensions held three memories in three formats, Claude Code held a fourth, Codex a fifth. Each harness had a memory; the user did not. Any fact learned in one harness was invisible to the others and to other machines. See the [context map](../specs/memory-context-map.md).

## Bounded contexts

One core context, Memory. Every harness (pi, Claude Code) and every legacy store is an external system behind an anti-corruption layer. OKF is upstream, adopted conformist.

## Ubiquitous language

OKF's own: bundle, concept, `type`, `index.md`, `log.md`, actor, `sources`, `status`. Ours only where OKF is silent: project id, the type vocabulary, Session Summary, secret refusal. "Memory" names the product, not a file. Stored: concepts and logs. Derived: indexes, project ids, context renders.

## Domain objects and invariants

See the [domain model](../specs/memory-domain-model.md).

| Aggregate root | Consistency boundary | Invariants that shaped this decision |
|---------------|----------------------|--------------------------------------|
| Concept | one file, one git commit | legal type for its directory; well-formed actor; no secret in text; slug from title; status transitions as drawn |

Index regeneration and log append happen after the concept write in the same application-level operation; a crash between leaves a stale index that `check` detects and `index` repairs. Eventually consistent by design, no cross-file lock.

## Anti-corruption layer

The `memory` CLI and library are the only writers. The pi extension translates pi hooks and tool calls into CLI calls; pi types stop at the extension. Claude Code hook scripts parse transcript JSONL and call the CLI; the library never sees Claude's formats. Each legacy store has one importer that emits concepts and is deleted when migration is done.

## Decision

An OKF v0.2 bundle at `~/.agents/memory`, a git repo. One npm package `@aeryx/memory` at `github.com/aeryx-ai/memory` holds library, CLI and pi extension; the Claude plugin lives in the same repo and shells out. Claude's native auto memory is turned off rather than redirected. Phasing: ship the CLI and migration, run migration and verify with `check`, ship the pi extension and uninstall the three, ship the Claude plugin and disable auto memory, delete `pi-extensions/claude-memory`.

## Consequences

Easier: one format, one write path, every invariant in one constructor, cross-machine sync by git, any harness with a shell can participate. Harder: Claude's "Saved N memories" affordance is gone; Claude summaries depend on `claude -p` running inside a hook; a rebase conflict on a concept needs a human. Deferred: Codex and opencode adapters, semantic search, consolidation, an MCP surface; revisit each when it is scheduled, not before.

## Alternatives considered

- Keep Claude auto memory native and normalize its files into OKF with a hook: two write paths and a tug of war over the index.
- An MCP server as the shared surface: a process per session and it still needs per-harness hooks for injection.
- A custom format instead of OKF: nothing gained; OKF already has provenance, trust, lifecycle and an index convention.
- A database (SQLite, Postgres): opaque to other harnesses and to git; markdown files are the interop.
