#!/usr/bin/env bash
# Sourced by session-start.sh, stop.sh, pre-compact.sh, session-end.sh.
# set -u (not -e): a failing memory call must never fail the hook. Every
# script that sources this always exits 0.
set -u
INPUT="$(cat)"
field() { printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");process.stdout.write(String(j[process.argv[1]]??""))})' "$1"; }
MEMORY_BIN="${MEMORY_BIN:-memory}"
SESSION_ID="$(field session_id)"; CWD="$(field cwd)"; TRANSCRIPT="$(field transcript_path)"; TRIGGER="$(field trigger)"
MODEL="${CLAUDE_MODEL:-$(field model)}"; MODEL="${MODEL:-claude}"
ACTOR="claude-code/${MODEL}"
SESSION="claude-code:session/${SESSION_ID}"
SUMMARIZE="${MEMORY_SUMMARIZE_CMD:-claude -p --model claude-haiku-4-5-20251001 --output-format text}"
# MEMORY_BIN may be a multi-word override (tests set it to "node <repo>/bin/memory.mjs"),
# so it must expand unquoted here to split into separate argv words; this is
# deliberate, not a missed quoting fix.
mem() { $MEMORY_BIN --cwd "$CWD" --actor "$ACTOR" "$@"; }
have_bundle() { $MEMORY_BIN --cwd "$CWD" doctor >/dev/null 2>&1 || [ -n "${MEMORY_DIR:-}" ]; }
