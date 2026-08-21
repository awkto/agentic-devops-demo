#!/bin/bash
# Bypass the Zammad setup wizard, create admin + API token, wire webhook trigger.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

zrails() {
  (cd /opt/zammad && docker compose exec -T zammad-railsserver bundle exec rails r "$1")
}

echo "waiting for zammad railsserver"
until zrails "puts 'up'" >/dev/null 2>&1; do sleep 5; done

zrails "
Setting.set('system_init_done', true)
Setting.set('fqdn', 'tickets.${DOMAIN}')
Setting.set('http_type', 'https')
Setting.set('organization', 'Ops Demo')
UserInfo.current_user_id = 1
u = User.find_by(login: 'admin@${DOMAIN}')
if u.nil?
  u = User.create!(login: 'admin@${DOMAIN}', email: 'admin@${DOMAIN}',
    firstname: 'Demo', lastname: 'Admin', password: '${ZAMMAD_ADMIN_PASSWORD}',
    verified: true, active: true, roles: Role.where(name: ['Admin', 'Agent']))
end
u.group_names_access_map = { 'Users' => 'full' }
u.save!
t = Token.find_by(action: 'api', user_id: u.id)
t ||= Token.create!(action: 'api', persistent: true, user_id: u.id,
  preferences: { permission: ['admin', 'ticket.agent'] })
File.write('/tmp/zammad_token', t.token)
w = Webhook.find_by(name: 'agent')
w ||= Webhook.create!(name: 'agent', endpoint: 'https://agent.${DOMAIN}/webhook/zammad',
  ssl_verify: true, active: true)
w.basic_auth_username = 'zammad'
w.basic_auth_password = '${WEBHOOK_SECRET}'
w.save!
unless Trigger.find_by(name: 'agent-new-ticket')
  Trigger.create!(name: 'agent-new-ticket',
    condition: { 'ticket.action' => { 'operator' => 'is', 'value' => 'create' } },
    perform: { 'notification.webhook' => { 'webhook_id' => w.id.to_s } },
    activator: 'action', execution_condition_mode: 'selective', active: true)
end
puts 'zammad ready'
"

mkdir -p /opt/demo/state
(cd /opt/zammad && docker compose exec -T zammad-railsserver cat /tmp/zammad_token) > /opt/demo/state/zammad_token
echo "zammad configured, token in /opt/demo/state/zammad_token"

# --- SAML via Keycloak (issue #6). Non-fatal: local login always remains. ---
echo "wiring zammad saml against keycloak"
IDP_CERT=$(curl -sf "https://sso.${DOMAIN}/realms/demo/protocol/saml/descriptor" \
  | grep -oPm1 '(?<=X509Certificate>)[^<]+' || true)
if [ -n "$IDP_CERT" ]; then
  zrails "
Setting.set('auth_saml_credentials', {
  display_name: 'SSO',
  idp_sso_target_url: 'https://sso.${DOMAIN}/realms/demo/protocol/saml',
  idp_slo_service_url: 'https://sso.${DOMAIN}/realms/demo/protocol/saml',
  idp_cert: \"-----BEGIN CERTIFICATE-----\n${IDP_CERT}\n-----END CERTIFICATE-----\",
  name_identifier_format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  security: 'off'
})
Setting.set('auth_saml', true)
puts 'saml on'
" || echo "WARN: zammad saml setup failed (local login unaffected)"
else
  echo "WARN: could not fetch keycloak saml descriptor, skipping zammad saml"
fi
