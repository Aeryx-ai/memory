#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
SESSION_ID="$(field session_id)"; CWD="$(field cwd)"
MODEL="${CLAUDE_MODEL:-$(field model)}"; MODEL="${MODEL:-claude}"
ACTOR="claude-code/${MODEL}"
SESSION="claude-code:session/${SESSION_ID}"
# Only point native compaction at the running summary when this session
# actually has one. A Session Summary's description names its session
# resource ("Session claude-code:session/<id>"), and that description is
# rendered into the project index that `mem context` includes, so grepping
# the context output for the session string is the simplest way to tell
# whether a "## Session summaries" entry for this session exists.
CTX="$(mem context --session "$SESSION" 2>/dev/null || true)"
if ! printf '%s' "$CTX" | grep -qF -- "$SESSION"; then exit 0; fi
node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreCompact",compactionInstructions:"A running session summary (reflections and observations) already covers this session and is re-injected after compaction. Summarize only the most recent turns: current task, open items, files being edited."}}))'
exit 0
