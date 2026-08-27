#!/bin/bash
# Seed the sandbox OpenBao: customer credentials, per-system agent policies,
# the agent AppRole (the real access gate, issue #17), and OIDC login for
# engineers via Keycloak (issue #6).
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
  services="nginx (website :80) and nodeapp (systemd unit, :3000) on cust1; postgresql (:5432) on db1 - separate host, secret customers/cust1-db, read-only for this agent" \
  wiki_page="Cust1" >/dev/null

# The database host. The agent holds a working credential (dbops) but the
# system is tiered read-only: the harness blocks write commands for it, and
# dbops has no sudo anyway. Diagnose freely, change nothing.
docker compose exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="${BAO_DEMO_TOKEN}" \
  openbao bao kv put secret/customers/cust1-db \
    host="db1.${DOMAIN}" \
    ssh_user=dbops \
    tier="read-only" \
    note="cust1 database host. Diagnostics only: read logs, configs, unit and port state. dbops has no sudo. Changes need an engineer, or an emergency grant of customers/cust1-db-admin." \
    ssh_private_key=- \
    < /opt/demo/state/agent_ed25519

# Emergency escalation for db1: root access, NOT granted to the agent role by
# default. An engineer grants it mid-incident:
#   scripts/grant-access.sh cust1-db-admin
docker compose exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="${BAO_DEMO_TOKEN}" \
  openbao bao kv put secret/customers/cust1-db-admin \
    host="db1.${DOMAIN}" \
    ssh_user=root \
    note="emergency root on the cust1 database host - granted by an engineer during an incident, revoke after" \
    ssh_private_key=- \
    < /opt/demo/state/agent_ed25519

# Restricted system for the access-grant demo: the backup account on cust1.
# Same key material, but the agent role does NOT carry this policy by default.
docker compose exec -T \
  -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="${BAO_DEMO_TOKEN}" \
  openbao bao kv put secret/customers/cust1-backups \
    host="cust1.${DOMAIN}" \
    ssh_user=backup \
    note="restricted: nightly database snapshots, backup account" \
    ssh_private_key=- \
    < /opt/demo/state/agent_ed25519

# --- Agent access gate: per-system policies + AppRole -----------------------
# Grant = attach a policy to the agent role; revoke = remove it. The harness
# re-logs-in on 403, so a grant takes effect on the agent's next attempt.
bao_exec policy write agent-base - <<'EOF'
path "secret/metadata/customers" {
  capabilities = ["list"]
}
EOF

bao_exec policy write agent-cust1 - <<'EOF'
path "secret/data/customers/cust1" {
  capabilities = ["read"]
}
path "secret/data/customers/cust1-meta" {
  capabilities = ["read"]
}
EOF

bao_exec policy write agent-cust1-backups - <<'EOF'
path "secret/data/customers/cust1-backups" {
  capabilities = ["read"]
}
EOF

bao_exec policy write agent-cust1-db - <<'EOF'
path "secret/data/customers/cust1-db" {
  capabilities = ["read"]
}
EOF

bao_exec policy write agent-cust1-db-admin - <<'EOF'
path "secret/data/customers/cust1-db-admin" {
  capabilities = ["read"]
}
EOF

bao_exec auth enable approle 2>/dev/null || true
bao_exec write auth/approle/role/agent \
  token_policies="agent-base,agent-cust1,agent-cust1-db" \
  token_ttl=1h token_max_ttl=4h
mkdir -p /opt/demo/state
bao_exec read -field=role_id auth/approle/role/agent/role-id > /opt/demo/state/bao_role_id
bao_exec write -f -field=secret_id auth/approle/role/agent/secret-id > /opt/demo/state/bao_secret_id

# --- Engineer SSO login (OIDC via Keycloak) ---------------------------------
# Non-fatal: the vault works with the root token either way, and Keycloak may
# still be warming up on a slow deploy.
if bao_exec policy write engineers - <<'EOF'
path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "sys/policies/acl/*" {
  capabilities = ["read", "list"]
}
path "auth/approle/role/agent" {
  capabilities = ["read", "update"]
}
EOF
then
  echo "waiting for keycloak realm"
  for _ in $(seq 1 30); do
    curl -sf "https://sso.${DOMAIN}/realms/demo/.well-known/openid-configuration" >/dev/null && break
    sleep 5
  done
  if curl -sf "https://sso.${DOMAIN}/realms/demo/.well-known/openid-configuration" >/dev/null; then
    bao_exec auth enable oidc 2>/dev/null || true
    bao_exec write auth/oidc/config \
      oidc_discovery_url="https://sso.${DOMAIN}/realms/demo" \
      oidc_client_id="openbao" \
      oidc_client_secret="${OIDC_CLIENT_SECRET}" \
      default_role="engineer" \
      && bao_exec write auth/oidc/role/engineer \
        user_claim="email" \
        token_policies="engineers" \
        allowed_redirect_uris="https://bao.${DOMAIN}/ui/vault/auth/oidc/oidc/callback" \
        allowed_redirect_uris="http://localhost:8250/oidc/callback" \
        ttl=8h \
      || echo "WARN: openbao oidc setup failed (login with token still works)"
  else
    echo "WARN: keycloak realm not reachable, skipping openbao oidc setup"
  fi
fi

echo "openbao seeded: customer secrets, agent approle (granted: cust1, cust1-db read-only), oidc login"
