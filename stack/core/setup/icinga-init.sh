#!/bin/bash
# Configure the icinga2 container: plugins, ssh key, demo config, features.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a
export AGENT_WEBHOOK_URL="https://agent.${DOMAIN}/webhook/icinga"

dc() { docker compose "$@"; }

echo "waiting for icinga2 container"
until dc exec -T icinga2 icinga2 --version >/dev/null 2>&1; do sleep 3; done

dc exec -u root -T icinga2 bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq curl jq openssh-client monitoring-plugins-basic gettext-base >/dev/null 2>&1 || true
  mkdir -p /data/ssh /data/scripts
'

envsubst '${ICINGA_API_PASSWORD} ${CUST1_IP} ${DOMAIN} ${AGENT_WEBHOOK_URL} ${WEBHOOK_SECRET}' \
  < icinga/demo.conf.tpl > /tmp/icinga-demo.conf
dc cp /tmp/icinga-demo.conf icinga2:/data/etc/icinga2/conf.d/demo.conf
dc cp icinga/notify-agent.sh icinga2:/data/scripts/notify-agent.sh
dc cp /opt/demo/state/agent_ed25519 icinga2:/data/ssh/agent_ed25519
rm -f /tmp/icinga-demo.conf

dc exec -u root -T icinga2 bash -c '
  rm -f /data/etc/icinga2/conf.d/hosts.conf
  printf "object IcingaDB \"icingadb\" {\n  host = \"icingadb-redis\"\n}\n" \
    > /data/etc/icinga2/features-available/icingadb.conf
  icinga2 feature enable icingadb api >/dev/null || true
  chown -R icinga:icinga /data/ssh /data/scripts /data/etc/icinga2/conf.d/demo.conf
  chmod 600 /data/ssh/agent_ed25519
  chmod +x /data/scripts/notify-agent.sh
'

dc restart icinga2
echo "icinga2 configured"
