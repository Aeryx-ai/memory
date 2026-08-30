#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
[ -z "$TRANSCRIPT" ] && exit 0
[ "${MEMORY_FOLD:-on}" = "off" ] && exit 0
mem fold --session "$SESSION" --transcript "$TRANSCRIPT" --format claude --finalize --summarize-cmd "$SUMMARIZE" >/dev/null 2>&1 || true
exit 0
