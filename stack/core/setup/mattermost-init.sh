#!/bin/bash
# First-run Mattermost setup: admin, demo engineers, team, channel, agent user + token.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

mm() { docker compose exec -T mattermost mmctl --local "$@"; }

echo "waiting for mattermost"
until mm system status >/dev/null 2>&1; do sleep 3; done

mm user create --email "admin@${DOMAIN}" --username sysadmin \
  --password "${MM_ADMIN_PASSWORD}" --system-admin --email-verified || true
mm user create --email "alice@${DOMAIN}" --username alice \
  --password "${DEMO_USER_PASSWORD}" --email-verified || true
mm user create --email "bob@${DOMAIN}" --username bob \
  --password "${DEMO_USER_PASSWORD}" --email-verified || true
mm user create --email "agent@${DOMAIN}" --username agent \
  --password "${DEMO_USER_PASSWORD}" --email-verified || true

mm team create --name ops --display-name "Ops" --private || true
mm team users add ops sysadmin alice bob agent || true
mm channel create --team ops --name incidents --display-name "Incidents" || true
mm channel users add ops:incidents sysadmin alice bob agent || true

mkdir -p /opt/demo/state
if [ ! -s /opt/demo/state/mm_token ]; then
  mm token generate agent agent-harness --json \
    | jq -r 'if type == "array" then .[0].token else .token end' > /opt/demo/state/mm_token
fi
echo "mattermost configured, agent token in /opt/demo/state/mm_token"
