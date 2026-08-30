# memory (Claude Code plugin)

Shared OKF memory bundle for Claude Code. Injects the bundle and recent session summaries at session start, folds a running summary in the background as the session grows, re-injects context after compaction, and finalizes the summary on exit. All writes go through the `memory` CLI.

## Install

```
npm i -g @aeryx/memory
claude plugin marketplace add aeryx-ai/memory
claude plugin install memory@aeryx
```

Then turn off Claude Code's own auto memory so the two don't fight, in `~/.claude/settings.json`:

```json
{ "autoMemoryEnabled": false }
```

Check the install:

```
memory doctor
```

`doctor` reports the bundle location, git remote, index health, any stuck fold, and whether `autoMemoryEnabled` is still on.

## What it does

- **SessionStart**: pulls the bundle, injects the project's memory index and recent session summaries as additional context.
- **Stop**: folds the transcript delta into a running Session Summary in the background (async, does not block the turn).
- **PreCompact**: tells the compactor a running summary already covers the session, so it only needs the most recent turns.
- **SessionEnd**: finalizes the Session Summary (`stable`) so it shows up at the next session start.

A `/memory` command and a `memory` skill are included: `/memory` runs `memory doctor` or `memory recall <args>`; the skill teaches the model when to `memory remember` a fact and when to leave it to the code and CLAUDE.md.
