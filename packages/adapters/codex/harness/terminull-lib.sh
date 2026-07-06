#!/bin/bash
# Terminull hook library (bash 3.2 — no declare -A, no process substitution).
#
# Contract, mirrored from control-tower's ct-lib.sh:
#  - A DOWN or undiscoverable panel is a SILENT no-op. A hook may NEVER slow or
#    break a worker session: every network call is bounded and failure-swallowed.
#  - The panel address is read from ~/.terminull/server.json (0600, written by
#    the panel server on boot). Absent → no-op everywhere. No hardcoded URL.
#  - Terminull's own tower/agent sessions are spawned with TERMINULL_AGENT=1;
#    their events must NOT flow back into the bus or the agent observes itself in
#    an infinite digest loop.
#  - Secrets are masked out of any free text before it leaves this machine.
#
# This file is SOURCED by each hook; an early `exit 0` here is the no-op path.

TN_DIR="$HOME/.terminull"
TN_SERVER="$TN_DIR/server.json"

# Tower/agent self-observation guard.
[ -n "$TERMINULL_AGENT" ] && exit 0

# Panel discovery. No file → no panel → no-op.
[ -f "$TN_SERVER" ] || exit 0
TN_URL=$(jq -r '.url // empty' "$TN_SERVER" 2>/dev/null)
[ -z "$TN_URL" ] && exit 0

# POST one event JSON to the panel. $1 = json body. Prints server response.
tn_emit() {
  curl -s --max-time 2 -X POST "$TN_URL/api/events" \
    -H 'Content-Type: application/json' \
    -d "$1" 2>/dev/null || true
}

# Same but with directive pickup (Stop hook). $1 = json body.
tn_emit_pickup() {
  curl -s --max-time 2 -X POST "$TN_URL/api/events?pickup=1" \
    -H 'Content-Type: application/json' \
    -d "$1" 2>/dev/null || true
}

# Mask obvious secrets in free text (house rule: secrets never leave raw).
# Patterns lifted from ct-lib.sh: OpenAI sk-, GitHub gh?_, Slack xox?-, AWS
# AKIA/ASIA, JWTs, underscore keys (stripe/api/token/secret), long tokens.
tn_mask() {
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{8,})/[REDACTED]/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9]{16,})/[REDACTED]/g' \
    -e 's/(xox[baprs]-[A-Za-z0-9-]{10,})/[REDACTED]/g' \
    -e 's/((AKIA|ASIA)[A-Z0-9]{16})/[REDACTED]/g' \
    -e 's/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/[REDACTED]/g' \
    -e 's/((sk|pk|rk|whsec|api|key|token|secret)_[A-Za-z0-9]{16,})/[REDACTED]/g' \
    -e 's/([A-Za-z0-9_-]{40,})/[REDACTED]/g'
}
