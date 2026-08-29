# Context Map: memory

## Ubiquitous language

| Term | Means | Lives in |
|------|-------|----------|
| Bundle | The OKF directory tree at `~/.agents/memory`, one per user, a git repo | Memory |
| Concept | One markdown file with YAML frontmatter; identity is its bundle-relative path | Memory |
| Type | OKF `type`: `User`, `Feedback`, `Project`, `Reference`, `Session Summary` | Memory |
| Directory | The bundle root or one `projects/<id>/`; owns an index and a log | Memory |
| Project id | `host/owner/repo` from the git origin, or `local/<basename>` | Memory |
| Index | `index.md`, generated from the frontmatter of a directory's concepts | Memory |
| Log | `log.md`, OKF §9 change history of a directory, appended on write | Memory |
| Actor | OKF §7 identity: `<producer>/<version>`, `human:<id>`, `process:<id>` | Memory |
| Source | OKF `sources[]` entry: what a concept derives from | Memory |
| Status | OKF `status`: `draft`, `stable`, `deprecated` | Memory |
| Session Summary | A concept of that type recording one compaction, exit or migrated day | Memory |
| Context render | The bytes a harness injects at session start: root index, project index, latest summaries | Memory |

## Contexts

| Context | Subdomain | About |
|---------|-----------|-------|
| Memory | core | The bundle, its concepts, indexes, logs, and every rule for writing them |

One context. Every harness and every legacy store speaks its own language and sits outside as an external system.

Inside Memory, groupings, one language throughout:

| Grouping | Owns |
|----------|------|
| Storage | Bundle, Directory, Concept, Index, Log |
| Provenance | Actor, Source |
| Rendering | Context render, recall ranking |

## Relationships

| Upstream | Downstream | Pattern | Notes |
|----------|-----------|---------|-------|
| Memory | pi harness | ACL | pi extension translates hook events and tool calls into CLI/library calls; pi types never enter the library |
| Memory | Claude Code harness | ACL | plugin hooks shell out to the CLI; transcript JSONL parsing lives in the hook script, not the library |
| Claude auto memory (legacy) | Memory | ACL | `migrate claude` importer |
| pi-hermes-memory (legacy) | Memory | ACL | `migrate hermes` importer |
| pi-memory (legacy) | Memory | ACL | `migrate pi-memory` importer |
| Codex memories (legacy) | Memory | ACL | `migrate codex` importer |
| OKF spec | Memory | Conformist | Memory adopts OKF vocabulary and file rules unchanged |
| Codex, opencode (live) | Memory | Separate Ways | no adapter; `~/.agents/AGENTS.md` points at the CLI |

## Ambiguous terms

| Term | Legacy meaning | Memory meaning | Resolution |
|------|-------------------|-------------------|------------|
| memory | Claude: one fact file; pi-memory: the whole store; hermes: one `§` entry | the product name only | a file is a concept, the store is the bundle |
| index | Claude: hand-maintained `MEMORY.md` | generated `index.md` | never hand-edited; `check` fails when stale |
| log | pi-memory: daily journal of work | OKF change history of the directory | work journal is a Session Summary concept |
| forget | pi-memory: delete with recovery file | `status: deprecated` | git history is recovery |

## Stored and derived

- Stored: every concept's frontmatter and body; `log.md` entries; the git remote.
- Derived, written for consumers but never trusted as truth: `index.md` (regenerated from frontmatter; `check` compares). Context render (never written).
- Derived, never stored: project id (from the repo at call time), trust tier (from `verified`), staleness (from `stale_after`).

## Still open

- Retagging hermes root entries that are `Project` rather than `Feedback` after import.
- Whether `claude -p` runs cleanly inside a Claude Code hook; if not, the Claude adapter's summaries need another summarizer.
- Session Summary retention past a few hundred per project.
