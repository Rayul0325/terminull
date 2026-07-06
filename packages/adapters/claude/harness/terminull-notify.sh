#!/bin/bash
# Notification → session.needs_permission / session.idle events.
# Notification hooks support systemMessage only — never hookSpecificOutput.
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
MSG=$(printf '%s' "$IN" | jq -r '.message // empty' 2>/dev/null | tn_mask | head -c 500)

case "$MSG" in
  *waiting*|*idle*) TYPE="session.idle" ;;
  *) TYPE="session.needs_permission" ;;
esac

tn_emit "$(jq -cn --arg sid "$SID" --arg t "$TYPE" --arg m "$MSG" \
  '{type:$t, tool:"claude", sessionId:$sid, payload:{message:$m}}')" >/dev/null
exit 0
