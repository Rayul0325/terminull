#!/bin/bash
# UserPromptSubmit → session.activity. Signals "a human is at this terminal" so
# the panel pauses auto-directives for this session. Never blocks.
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0

tn_emit "$(jq -cn --arg sid "$SID" \
  '{type:"session.activity", tool:"claude", sessionId:$sid, payload:{kind:"user_prompt"}}')" >/dev/null
exit 0
