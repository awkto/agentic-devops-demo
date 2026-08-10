#!/bin/bash
# Run on the core droplet as root. Expects /opt/demo to be a checkout of this
# repo with stack/core/.env rendered and /opt/demo/state/agent_ed25519 present.
set -euo pipefail
cd /opt/demo/stack/core
set -a; source ./.env; set +a

docker network inspect demo >/dev/null 2>&1 || docker network create demo

# render keycloak realm from template
mkdir -p keycloak
sed -e "s/__DOMAIN__/${DOMAIN}/g" -e "s/__DEMO_USER_PASSWORD__/${DEMO_USER_PASSWORD}/g" \
  keycloak-realm.json.tpl > keycloak/demo-realm.json

docker compose up -d

if [ ! -d /opt/zammad ]; then
  git clone --depth 1 https://github.com/zammad/zammad-docker-compose /opt/zammad
fi
(cd /opt/zammad && POSTGRES_PASS="${POSTGRES_PASSWORD}" docker compose \
  -f docker-compose.yml -f /opt/demo/stack/core/zammad-override.yml up -d)

bash setup/mattermost-init.sh
bash setup/wiki-init.sh
bash setup/bao-init.sh
bash setup/icinga-init.sh
bash setup/zammad-init.sh

echo "core bootstrap complete"
