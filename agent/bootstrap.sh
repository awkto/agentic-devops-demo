#!/bin/bash
# Run on the agent droplet as root. Expects /opt/demo to be a checkout of this
# repo and /opt/agent/.env to have been placed by the deploy script.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy
fi

mkdir -p /opt/agent
rsync -a --delete --exclude .env --exclude node_modules \
  --exclude state.json --exclude .claude --exclude sessions --exclude work \
  --exclude alerts.jsonl --exclude activity.jsonl \
  /opt/demo/agent/ /opt/agent/
(cd /opt/agent && npm install --omit=dev --no-audit --no-fund >/dev/null)

source /opt/agent/.env
cat > /etc/caddy/Caddyfile <<EOF
agent.${DOMAIN} {
	reverse_proxy localhost:8080
}
EOF
systemctl reload caddy || systemctl restart caddy

id agentd >/dev/null 2>&1 || useradd -r -d /opt/agent -s /usr/sbin/nologin agentd
chown -R agentd:agentd /opt/agent
chmod 600 /opt/agent/.env

cp /opt/demo/agent/agentd.service /etc/systemd/system/agentd.service
systemctl daemon-reload
systemctl enable agentd
systemctl restart agentd
echo "agent harness deployed"
