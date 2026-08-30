#!/usr/bin/env bash
# Sourced by session-start.sh, stop.sh, pre-compact.sh, session-end.sh.
# set -u (not -e): a failing memory call must never fail the hook. Every
# script that sources this always exits 0.
set -u
# The default SUMMARIZE command below is itself a `claude -p` invocation. If
# the memory plugin is installed at user scope (the normal case), that nested
# claude session loads these same hooks and would recurse into another fold
# on itself. MEMORY=off is the explicit escape hatch for a custom
# --summarize-cmd; MEMORY_PROMPT_FILE is set unconditionally by fold.mjs's
# runSummarizer around every summarizer child it spawns, so it gates even a
# custom command that forgets MEMORY=off. Both are checked before stdin is
# read so a gated invocation never blocks on it.
if [ "${MEMORY:-on}" = "off" ] || [ -n "${MEMORY_PROMPT_FILE:-}" ]; then exit 0; fi
INPUT="$(cat)"
field() { printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");process.stdout.write(String(j[process.argv[1]]??""))})' "$1"; }
MEMORY_BIN="${MEMORY_BIN:-memory}"
SUMMARIZE="${MEMORY_SUMMARIZE_CMD:-MEMORY=off claude -p --model claude-haiku-4-5-20251001 --output-format text}"
# MEMORY_BIN may be a multi-word override (tests set it to "node <repo>/bin/memory.mjs"),
# so it must expand unquoted here to split into separate argv words; this is
# deliberate, not a missed quoting fix.
mem() { $MEMORY_BIN --cwd "$CWD" --actor "$ACTOR" "$@"; }
