#!/bin/bash
# Keycloak wiring for the agent harness /admin area (issue #34): confidential
# client "agent-admin", realm roles agent-admin (alice) and agent-viewer (bob),
# roles delivered in the ID token as the "roles" claim. Idempotent. The client
# secret is supplied by the operator vault (AGENT_ADMIN_CLIENT_SECRET) so the
# agent .env and Keycloak always agree.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

kc_ok=""
for i in $(seq 1 40); do
  if kc config credentials --server http://localhost:8080 --realm master \
    --user admin --password "${KEYCLOAK_ADMIN_PASSWORD}" >/dev/null 2>&1; then kc_ok=1; break; fi
  sleep 3
done
if [ -z "$kc_ok" ] || ! kc get realms/demo >/dev/null 2>&1; then
  echo "WARNING: keycloak unreachable, agent-admin client not created"
  exit 0
fi

for role in agent-admin agent-viewer; do
  kc create roles -r demo -s name="$role" 2>/dev/null || true
done
kc add-roles -r demo --uusername alice --rolename agent-admin
kc add-roles -r demo --uusername bob --rolename agent-viewer

CLIENT_JSON=(-s clientId=agent-admin -s protocol=openid-connect
  -s publicClient=false -s standardFlowEnabled=true -s directAccessGrantsEnabled=false
  -s "redirectUris=[\"https://agent.${DOMAIN}/admin/callback\"]"
  -s "webOrigins=[\"https://agent.${DOMAIN}\"]"
  -s "secret=${AGENT_ADMIN_CLIENT_SECRET}")
CLIENT_UID=$(kc get clients -r demo -q clientId=agent-admin --fields id --format csv --noquotes)
if [ -z "$CLIENT_UID" ]; then
  kc create clients -r demo "${CLIENT_JSON[@]}"
  CLIENT_UID=$(kc get clients -r demo -q clientId=agent-admin --fields id --format csv --noquotes)
else
  kc update "clients/${CLIENT_UID}" -r demo "${CLIENT_JSON[@]}"
fi

# realm roles into the ID token as a flat "roles" array
if ! kc get "clients/${CLIENT_UID}/protocol-mappers/models" -r demo --fields name --format csv --noquotes | grep -qx roles; then
  kc create "clients/${CLIENT_UID}/protocol-mappers/models" -r demo \
    -s name=roles -s protocol=openid-connect -s protocolMapper=oidc-usermodel-realm-role-mapper \
    -s 'config."claim.name"=roles' -s 'config."multivalued"=true' \
    -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=false' \
    -s 'config."userinfo.claim"=false' -s 'config."jsonType.label"=String'
fi
echo "keycloak: agent-admin client and roles ready"
