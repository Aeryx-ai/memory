---
name: memory
description: Use when the user corrects you, states a preference, decides something the code will not show, or asks you to remember or recall something. Saves and searches the shared OKF memory bundle through the memory CLI.
---

# memory

The bundle at `~/.agents/memory` is shared by every coding agent on every machine. Write only through the CLI.

## When to remember
- `User`: role, expertise, working preferences. Always `--root`.
- `Feedback`: a correction you were given or an approach the user confirmed. `--root` when it applies everywhere, otherwise project.
- `Project`: ongoing work, decisions, constraints the code and git history do not show.
- `Reference`: where to find something outside the repo.
Skip anything derivable from the codebase and anything CLAUDE.md already says.

## Commands
- `memory remember --type Feedback --title "Reminders via Telegram" --description "one sentence" <<'EOF'` then the body then `EOF`. Same title revises in place.
- `memory recall <terms>` (add `--type Project`), `memory show <slug>`, `memory deprecate <slug>`, `memory restore <slug>`.
- `memory recall-observation <id>` expands a `[id]` line from a session summary.
- `memory doctor` when something looks off.
Output is JSON; add `--md` for markdown. Exit 3 means the write was refused (a secret, or a type not allowed at that level); do not retry with the secret removed by hand, rephrase without it.
