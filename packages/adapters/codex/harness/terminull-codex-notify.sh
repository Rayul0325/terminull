#!/bin/bash
# Codex `notify` wrapper (ported from control-tower's ct-codex-notify.sh).
#
# Codex invokes:  notify[0] notify[1..] "turn-ended" <json>
# When Terminull's injector wires the config.toml notify array it prepends THIS
# script, so at runtime this script is arg0 and the ORIGINAL notify client + its
# args follow. We POST a `codex.turn` event to the panel, then chain-exec the
# original client so Codex Desktop behaviour is unchanged. A down/undiscoverable
# panel is a silent no-op (see terminull-lib.sh), so a worker turn is never slowed.
#
# bash 3.2 only (no `declare -A`, no process substitution).
. "$(dirname "$0")/terminull-lib.sh"

REAL="$1"; shift          # original notify client path is our first arg
PAYLOAD="$*"              # remaining args (e.g. "turn-ended {json}")

tn_emit "$(jq -cn --arg p "$(printf '%s' "$PAYLOAD" | tn_mask)" \
  '{type:"codex.turn", tool:"codex", payload:{event:$p}}')" >/dev/null 2>&1 || true

# Hand off to the real notify client so Codex Desktop keeps working.
[ -n "$REAL" ] && [ -x "$REAL" ] && exec "$REAL" "$@"
exit 0
