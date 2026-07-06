#!/bin/bash
# SessionEnd → session.end event. systemMessage only — NO hookSpecificOutput
# here (emitting it on SessionEnd invalidates the whole hook output).
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
REASON=$(printf '%s' "$IN" | jq -r '.reason // empty' 2>/dev/null)

tn_emit "$(jq -cn --arg sid "$SID" --arg r "$REASON" \
  '{type:"session.end", tool:"claude", sessionId:$sid, payload:{reason:$r}}')" >/dev/null
exit 0
