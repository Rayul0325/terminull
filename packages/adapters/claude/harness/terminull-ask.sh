#!/bin/bash
# PreToolUse(AskUserQuestion) → session.ask event, NON-blocking (exit 0 so the
# TUI renders the menu normally). The user answers from the panel; the server
# navigates the menu by option position. The panel never auto-answers asks.
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
QS=$(printf '%s' "$IN" | jq -c '.tool_input.questions // []' 2>/dev/null)
[ -z "$QS" ] || [ "$QS" = "[]" ] && exit 0
ASK_ID="${SID:0:8}-$(date +%s)"

tn_emit "$(jq -cn --arg sid "$SID" --arg cwd "$CWD" --arg aid "$ASK_ID" --argjson qs "$QS" \
  '{type:"session.ask", tool:"claude", sessionId:$sid, cwd:$cwd, askId:$aid, payload:{questions:$qs}}')" >/dev/null
exit 0
