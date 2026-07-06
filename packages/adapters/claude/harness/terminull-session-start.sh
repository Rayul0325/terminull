#!/bin/bash
# SessionStart → session.start event. Non-blocking, silent no-op on panel-down.
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
SRC=$(printf '%s' "$IN" | jq -r '.source // empty' 2>/dev/null)

tn_emit "$(jq -cn --arg sid "$SID" --arg cwd "$CWD" --arg src "$SRC" \
  '{type:"session.start", tool:"claude", sessionId:$sid, cwd:$cwd, payload:{source:$src}}')" >/dev/null
exit 0
