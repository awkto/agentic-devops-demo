#!/bin/bash
# Seed the sandbox OpenBao with customer access credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

bao_exec() {
  docker compose exec -T \
    -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="${BAO_DEMO_TOKEN}" \
    openbao bao "$@"
}

echo "waiting for openbao"
until bao_exec status >/dev/null 2>&1; do sleep 2; done

docker compose exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="${BAO_DEMO_TOKEN}" \
  openbao bao kv put secret/customers/cust1 \
    host="cust1.${DOMAIN}" \
    ssh_user=root \
    ssh_private_key=- \
    < /opt/demo/state/agent_ed25519

bao_exec kv put secret/customers/cust1-meta \
  services="nginx (website :80), nodeapp (systemd unit, :3000), postgresql (:5432 local)" \
  wiki_page="Cust1" >/dev/null
echo "openbao seeded"
