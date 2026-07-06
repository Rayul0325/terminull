#!/bin/bash
# Stop → (a) POST session.report with a masked tail of the last assistant
# message, (b) pick up queued panel directives; if any, block with the directive
# as reason so the session continues on it (turn-boundary inject).
#
# Safety: respects stop_hook_active (never re-block our own continuation);
# panel-down → silent exit 0; total budget ~2.5s (curl --max-time 2).
. "$(dirname "$0")/terminull-lib.sh"

IN=$(cat)
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SID" ] && exit 0
ACTIVE=$(printf '%s' "$IN" | jq -r '.stop_hook_active // false' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$IN" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)

# Last assistant text (cheap: tail window only; transcripts can be 60MB+).
TAIL=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  TAIL=$(tail -c 60000 "$TRANSCRIPT" 2>/dev/null \
    | grep '"type":"assistant"' | tail -1 \
    | jq -r '[.message.content[]? | select(.type=="text") | .text] | join(" ")' 2>/dev/null \
    | tn_mask | head -c 1500)
fi

REPORT="$(jq -cn --arg sid "$SID" --arg cwd "$CWD" --arg tail "$TAIL" \
  '{type:"session.report", tool:"claude", sessionId:$sid, cwd:$cwd, payload:{lastAssistantText:$tail}}')"

# Re-entry guard: when we already blocked once, report WITHOUT pickup — else the
# server marks queued directives 'delivered' that this pass will never inject,
# silently dropping them. Pickup only on a real turn end.
if [ "$ACTIVE" = "true" ]; then
  tn_emit "$REPORT" >/dev/null
  exit 0
fi

RESP=$(tn_emit_pickup "$REPORT")
DIRECTIVE=$(printf '%s' "$RESP" | jq -r '[.directives[]?.text] | join("\n---\n")' 2>/dev/null)
if [ -n "$DIRECTIVE" ] && [ "$DIRECTIVE" != "null" ]; then
  jq -cn --arg d "$DIRECTIVE" \
    '{decision:"block", reason:("[Terminull directive] Perform the following:\n" + $d)}'
fi
exit 0
