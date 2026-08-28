#!/bin/bash
# Put the sandbox back to a clean pre-take state. Run between recordings.
#
# Undoes every break, revokes any emergency grant, and clears the history the
# agent reads about itself - its sessions, alert and activity logs, the
# Incidents channel, the tickets it filed, and the auth logs that make an
# operator breaking things on purpose look like an intruder.
#
# Needs: bao authenticated on the operator machine, jq, curl, ssh.
set -uo pipefail
cd "$(dirname "$0")/.."
DOMAIN=${DOMAIN:-gobyl.cc}
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

bg() { bao kv get -format=json "$1" | jq -r ".data.data.$2"; }

echo "==> undoing breaks on the customer hosts"
$SSH "root@cust1.$DOMAIN" "bash /opt/break/restore-all.sh" >/dev/null 2>&1
$SSH "root@db1.$DOMAIN" "bash /opt/break/restore-db.sh" >/dev/null 2>&1

echo "==> revoking emergency grants"
for sys in cust1-db-admin; do
  if bash scripts/grant-access.sh | grep -q "agent-$sys"; then
    bash scripts/grant-access.sh "$sys" revoke >/dev/null
    echo "    revoked $sys"
  fi
done

echo "==> clearing the operator SSH trail"
# Every break lands as a root login seconds before a service dies. True, but it
# reads as sabotage to an agent that has no idea a demo is being recorded.
for h in "cust1.$DOMAIN" "db1.$DOMAIN"; do
  $SSH "root@$h" "systemctl stop rsyslog 2>/dev/null; : > /var/log/auth.log; : > /var/log/wtmp; : > /var/log/btmp; systemctl start rsyslog 2>/dev/null; journalctl --rotate -q; journalctl --vacuum-time=1s -q" >/dev/null 2>&1
done

echo "==> clearing agent memory"
$SSH "root@agent.$DOMAIN" "systemctl stop agentd; rm -f /opt/agent/sessions/*.json /opt/agent/state.json /opt/agent/alerts.jsonl /opt/agent/activity.jsonl; systemctl start agentd" >/dev/null 2>&1

echo "==> wiping the Incidents channel"
MMPW=$(bg agentic-demo/mattermost admin_password)
MMTOK=$(curl -s -i -X POST "https://chat.$DOMAIN/api/v4/users/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login_id\":\"sysadmin\",\"password\":\"$MMPW\"}" | awk '/^[Tt]oken:/{print $2}' | tr -d '\r')
if [ -n "$MMTOK" ]; then
  CH=$(curl -s -H "Authorization: Bearer $MMTOK" "https://chat.$DOMAIN/api/v4/teams/name/ops/channels/name/incidents" | jq -r .id)
  n=0
  for id in $(curl -s -H "Authorization: Bearer $MMTOK" "https://chat.$DOMAIN/api/v4/channels/$CH/posts?per_page=200" \
      | jq -r '.posts | to_entries[] | select(.value.root_id == "" and .value.delete_at == 0) | .key'); do
    curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MMTOK" "https://chat.$DOMAIN/api/v4/posts/$id"
    n=$((n+1))
  done
  echo "    deleted $n threads"
else
  echo "    WARNING: could not log in to Mattermost, channel left as is" >&2
fi

echo "==> removing the tickets the agent filed"
ZTOK=$(bg agentic-demo/zammad-api token)
n=0
for id in $(curl -s -H "Authorization: Token token=$ZTOK" "https://tickets.$DOMAIN/api/v1/tickets?per_page=100" \
    | jq -r '.[] | select(.title | startswith("[icinga]")) | .id'); do
  curl -s -o /dev/null -X DELETE -H "Authorization: Token token=$ZTOK" "https://tickets.$DOMAIN/api/v1/tickets/$id"
  n=$((n+1))
done
echo "    deleted $n tickets"

echo "==> verifying"
sleep 5
printf '    site  %s\n' "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://cust1.$DOMAIN/")"
printf '    api   %s\n' "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://cust1.$DOMAIN:3000/api/positions")"
ICINGA_PW=$(bg agentic-demo/icinga api_password)
curl -sk -u "agent:$ICINGA_PW" "https://icinga-api.$DOMAIN/v1/objects/services" \
  -H 'Accept: application/json' \
  | jq -r '.results[] | "    \(.attrs.host_name)/\(.attrs.name)  \(if .attrs.state == 0 then "OK" else "STATE \(.attrs.state)" end)"' 2>/dev/null \
  || echo "    (icinga query failed)"
echo "==> reset complete"
