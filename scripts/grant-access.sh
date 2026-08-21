#!/bin/bash
# Grant or revoke the agent's access to a system, at the OpenBao level.
# Runs on the operator machine (needs bao authenticated against the operator
# vault, jq, curl). Talks to the sandbox OpenBao at bao.$DOMAIN.
#
#   scripts/grant-access.sh cust1-backups          # grant
#   scripts/grant-access.sh cust1-backups revoke   # revoke
#   scripts/grant-access.sh                        # show current grants
set -euo pipefail
DOMAIN=${DOMAIN:-gobyl.cc}
SYSTEM=${1:-}
ACTION=${2:-grant}

TOKEN=$(bao kv get -format=json agentic-demo/openbao-demo | jq -r .data.data.root_token)
API="https://bao.${DOMAIN}/v1"

current() {
  curl -sf -H "X-Vault-Token: $TOKEN" "$API/auth/approle/role/agent" \
    | jq -r '.data.token_policies | join(",")'
}

if [ -z "$SYSTEM" ]; then
  echo "agent role policies: $(current)"
  exit 0
fi

POLICY="agent-${SYSTEM}"
POLICIES=$(current)
case "$ACTION" in
  grant)
    NEW=$(echo "$POLICIES,$POLICY" | tr ',' '\n' | sort -u | paste -sd, -)
    ;;
  revoke)
    NEW=$(echo "$POLICIES" | tr ',' '\n' | grep -vx "$POLICY" | paste -sd, -)
    ;;
  *)
    echo "usage: $0 <system> [grant|revoke]" >&2; exit 1
    ;;
esac

curl -sf -X POST -H "X-Vault-Token: $TOKEN" \
  -d "{\"token_policies\": \"$NEW\"}" \
  "$API/auth/approle/role/agent"
echo "agent role policies now: $(current)"
echo "(takes effect on the agent's next vault access - it re-logs-in on denial)"
