#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
SESSION_ID="$(field session_id)"; CWD="$(field cwd)"; TRANSCRIPT="$(field transcript_path)"
MODEL="${CLAUDE_MODEL:-$(field model)}"; MODEL="${MODEL:-claude}"
ACTOR="claude-code/${MODEL}"
SESSION="claude-code:session/${SESSION_ID}"
[ -z "$TRANSCRIPT" ] && exit 0
[ "${MEMORY_FOLD:-on}" = "off" ] && exit 0
mem fold --session "$SESSION" --transcript "$TRANSCRIPT" --format claude --summarize-cmd "$SUMMARIZE" >/dev/null 2>&1 || true
exit 0
