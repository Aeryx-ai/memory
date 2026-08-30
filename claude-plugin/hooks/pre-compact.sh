#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreCompact",compactionInstructions:"A running session summary (reflections and observations) already covers this session and is re-injected after compaction. Summarize only the most recent turns: current task, open items, files being edited."}}))'
exit 0
