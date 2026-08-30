#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
( mem sync --pull >/dev/null 2>&1 & ) 2>/dev/null
CTX="$(mem context --session "$SESSION" 2>/dev/null || true)"
[ -z "$CTX" ] && exit 0
NOTE='Memory: save a durable fact with `memory remember --type <User|Feedback|Project|Reference> --title "..." --description "..." <<< "body"` (add --root for User or bundle-wide Feedback). Search with `memory recall <terms>`. Expand a [id] line with `memory recall-observation <id>`. Never write memory files by hand.'
node -e 'const [ctx,note]=process.argv.slice(1);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:ctx+"\n"+note}}))' "$CTX" "$NOTE"
exit 0
