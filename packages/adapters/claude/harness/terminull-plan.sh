#!/bin/bash
# PostToolUse(ExitPlanMode) → session.plan_approved. PostToolUse fires ONLY when
# the tool SUCCEEDS, i.e. the plan was APPROVED (the reject path never reaches
# here). So this is a post-approval signal. Reads tool_input.planFilePath (+the
# inline plan) which Claude Code injects before the hook. Never blocks.
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
PLAN=$(printf '%s' "$IN" | jq -r '.tool_input.planFilePath // empty' 2>/dev/null)

tn_emit "$(jq -cn --arg sid "$SID" --arg cwd "$CWD" --arg plan "$PLAN" \
  '{type:"session.plan_approved", tool:"claude", sessionId:$sid, cwd:$cwd, payload:{planFilePath:$plan}}')" >/dev/null
exit 0
