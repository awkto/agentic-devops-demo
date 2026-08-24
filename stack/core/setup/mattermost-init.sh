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

# SSO via Keycloak (issue #6): Team Edition has no OIDC, but its GitLab login
# is plain OAuth2, so point the endpoints at the realm. The "mattermost"
# client maps gitlab_id/username claims into the GitLab user-JSON shape.
# Password login stays enabled as fallback.
mm config set GitLabSettings.Enable true || true
mm config set GitLabSettings.Id mattermost || true
mm config set GitLabSettings.Secret "${OIDC_CLIENT_SECRET}" || true
# Scope must stay empty: Mattermost routes any scope containing "openid" to
# its enterprise-only OpenID provider and the GitLab button 501s. The openid
# scope the userinfo endpoint needs is attached on the Keycloak side below.
mm config set GitLabSettings.Scope "" || true
mm config set GitLabSettings.AuthEndpoint "https://sso.${DOMAIN}/realms/demo/protocol/openid-connect/auth" || true
mm config set GitLabSettings.TokenEndpoint "https://sso.${DOMAIN}/realms/demo/protocol/openid-connect/token" || true
mm config set GitLabSettings.UserAPIEndpoint "https://sso.${DOMAIN}/realms/demo/protocol/openid-connect/userinfo" || true

# Keycloak 24+ refuses the userinfo call unless the access token carries the
# openid scope, and Mattermost cannot request it (see Scope note above). A
# client scope literally named "openid", attached as a default scope on the
# mattermost client, puts it in every token unrequested. Best-effort: SSO is
# optional, password login still works if Keycloak is not up yet.
kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
kc_ok=""
for i in $(seq 1 40); do
  if kc config credentials --server http://localhost:8080 --realm master \
    --user admin --password "${KEYCLOAK_ADMIN_PASSWORD}" >/dev/null 2>&1; then kc_ok=1; break; fi
  sleep 3
done
if [ -n "$kc_ok" ] && kc get realms/demo >/dev/null 2>&1; then
  kc create client-scopes -r demo -s name=openid -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' 2>/dev/null || true
  SCOPE_ID=$(kc get client-scopes -r demo --fields id,name --format csv --noquotes | awk -F, '$2=="openid"{print $1}')
  CLIENT_UID=$(kc get clients -r demo -q clientId=mattermost --fields id --format csv --noquotes)
  if [ -n "$SCOPE_ID" ] && [ -n "$CLIENT_UID" ]; then
    kc update "clients/${CLIENT_UID}/default-client-scopes/${SCOPE_ID}" -r demo || true
    echo "keycloak: openid default scope attached to mattermost client"
  fi
else
  echo "WARNING: keycloak unreachable, mattermost SSO userinfo scope not wired"
fi

# Mattermost refuses a GitLab SSO login when an email account with the same
# address already exists, so flip the demo engineers to gitlab auth at the DB
# level (authdata = the realm's gitlab_id attribute: alice 1001, bob 1002).
# sysadmin stays on password as the always-working admin fallback.
pg() { docker compose exec -T mm-postgres psql -U mmuser -d mattermost -qtAc "$1"; }
pg "UPDATE users SET authservice='gitlab', authdata='1001', password='' WHERE username='alice' AND authservice='';" || true
pg "UPDATE users SET authservice='gitlab', authdata='1002', password='' WHERE username='bob' AND authservice='';" || true

mkdir -p /opt/demo/state
if [ ! -s /opt/demo/state/mm_token ]; then
  mm token generate agent agent-harness --json \
    | jq -r 'if type == "array" then .[0].token else .token end' > /opt/demo/state/mm_token
fi
echo "mattermost configured, agent token in /opt/demo/state/mm_token"
