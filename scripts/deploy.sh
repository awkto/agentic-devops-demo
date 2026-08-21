#!/bin/bash
# Deploys the whole sandbox. Requirements on the operator machine:
# terraform, bao (authenticated), jq, ssh, rsync.
# Secrets layout expected in OpenBao is described in the README.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DOMAIN=${DOMAIN:-gobyl.cc}

bg() { bao kv get -format=json "$1" | jq -r ".data.data.$2"; }

echo "==> pulling secrets"
export TF_VAR_do_token_team=$(bg kv/digitalocean/teamadf token)
export TF_VAR_do_token_dns=$(bg kv/digitalocean/myteam token)
export TF_VAR_ops_ssh_public_key=$(bg agentic-demo/ssh-ops public_key)
export TF_VAR_agent_ssh_public_key=$(bg agentic-demo/ssh-agent public_key)

echo "==> terraform"
(cd terraform && terraform init -input=false >/dev/null && terraform apply -auto-approve)
CORE_IP=$(cd terraform && terraform output -raw core_ip)
AGENT_IP=$(cd terraform && terraform output -raw agent_ip)
CUST1_IP=$(cd terraform && terraform output -raw cust1_ip)
echo "core=$CORE_IP agent=$AGENT_IP cust1=$CUST1_IP"

OPS_KEY=$(mktemp)
trap 'rm -f "$OPS_KEY"' EXIT
bg agentic-demo/ssh-ops private_key > "$OPS_KEY"
chmod 600 "$OPS_KEY"
SSH_OPTS="-i $OPS_KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

wait_ssh() {
  echo "waiting for ssh on $1"
  until ssh $SSH_OPTS -o ConnectTimeout=5 "root@$1" true 2>/dev/null; do sleep 5; done
}
wait_cloudinit() {
  ssh $SSH_OPTS "root@$1" cloud-init status --wait >/dev/null || true
}

for ip in "$CORE_IP" "$AGENT_IP" "$CUST1_IP"; do wait_ssh "$ip"; done
for ip in "$CORE_IP" "$AGENT_IP" "$CUST1_IP"; do wait_cloudinit "$ip"; done

sync_repo() {
  ssh $SSH_OPTS "root@$1" "command -v rsync >/dev/null || apt-get install -y -qq rsync"
  rsync -az --delete -e "ssh $SSH_OPTS" \
    --exclude .git --exclude terraform/.terraform --exclude 'terraform/*tfstate*' \
    "$ROOT/" "root@$1:/opt/demo/"
}

echo "==> render core env"
CORE_ENV=$(mktemp)
cat > "$CORE_ENV" <<EOF
DOMAIN=$DOMAIN
CUST1_IP=$CUST1_IP
POSTGRES_PASSWORD=$(bg agentic-demo/postgres password)
KEYCLOAK_ADMIN_PASSWORD=$(bg agentic-demo/keycloak admin_password)
MM_ADMIN_PASSWORD=$(bg agentic-demo/mattermost admin_password)
ZAMMAD_ADMIN_PASSWORD=$(bg agentic-demo/zammad admin_password)
ICINGA_ADMIN_PASSWORD=$(bg agentic-demo/icinga admin_password)
ICINGA_API_PASSWORD=$(bg agentic-demo/icinga api_password)
WIKI_ADMIN_PASSWORD=$(bg agentic-demo/mediawiki admin_password)
BAO_DEMO_TOKEN=$(bg agentic-demo/openbao-demo root_token)
WEBHOOK_SECRET=$(bg agentic-demo/webhook shared_secret)
DEMO_USER_PASSWORD=$(bg agentic-demo/demo-users password)
OIDC_CLIENT_SECRET=$(bg agentic-demo/keycloak oidc_client_secret)
EOF

echo "==> customer host"
sync_repo "$CUST1_IP"
ssh $SSH_OPTS "root@$CUST1_IP" "AGENT_PUB='$(bg agentic-demo/ssh-agent public_key)' bash /opt/demo/customer/setup.sh"

echo "==> core host"
sync_repo "$CORE_IP"
scp $SSH_OPTS "$CORE_ENV" "root@$CORE_IP:/opt/demo/stack/core/.env"
ssh $SSH_OPTS "root@$CORE_IP" "mkdir -p /opt/demo/state"
bg agentic-demo/ssh-agent private_key | ssh $SSH_OPTS "root@$CORE_IP" \
  "cat > /opt/demo/state/agent_ed25519 && chmod 600 /opt/demo/state/agent_ed25519"
ssh $SSH_OPTS "root@$CORE_IP" "bash /opt/demo/stack/core/bootstrap.sh"

echo "==> collect generated tokens"
MM_TOKEN=$(ssh $SSH_OPTS "root@$CORE_IP" cat /opt/demo/state/mm_token)
ZAMMAD_TOKEN=$(ssh $SSH_OPTS "root@$CORE_IP" cat /opt/demo/state/zammad_token)
BAO_ROLE_ID=$(ssh $SSH_OPTS "root@$CORE_IP" cat /opt/demo/state/bao_role_id)
BAO_SECRET_ID=$(ssh $SSH_OPTS "root@$CORE_IP" cat /opt/demo/state/bao_secret_id)
bao kv put agentic-demo/mattermost-bot token="$MM_TOKEN" >/dev/null
bao kv put agentic-demo/zammad-api token="$ZAMMAD_TOKEN" >/dev/null

echo "==> agent host"
sync_repo "$AGENT_IP"

# MODEL_PROVIDER=fireworks runs the harness's own loop against Fireworks;
# anthropic (default) keeps the Claude Agent SDK path. Override AGENT_MODEL to
# pick a specific model either way.
MODEL_PROVIDER=${MODEL_PROVIDER:-anthropic}
if [ "$MODEL_PROVIDER" = "fireworks" ]; then
  MODEL_BASE_URL=$(bg agentic-demo/fireworks base_url)
  MODEL_API_KEY=$(bg agentic-demo/fireworks api_key)
  AGENT_MODEL=${AGENT_MODEL:-accounts/fireworks/models/qwen3p7-plus}
else
  MODEL_BASE_URL=${MODEL_BASE_URL:-}
  MODEL_API_KEY=${MODEL_API_KEY:-}
  AGENT_MODEL=${AGENT_MODEL:-claude-sonnet-5}
fi
echo "model provider: $MODEL_PROVIDER, model: $AGENT_MODEL"

AGENT_ENV=$(mktemp)
cat > "$AGENT_ENV" <<EOF
DOMAIN=$DOMAIN
PORT=8080
ANTHROPIC_API_KEY=$(bg agentic-demo/anthropic api_key)
MODEL_BASE_URL=$MODEL_BASE_URL
MODEL_API_KEY=$MODEL_API_KEY
AGENT_MODEL=$AGENT_MODEL
AGENT_DEFAULT_MODE=read-write
WEBHOOK_SECRET=$(bg agentic-demo/webhook shared_secret)
MM_URL=https://chat.$DOMAIN
MM_BOT_TOKEN=$MM_TOKEN
MM_TEAM=ops
MM_CHANNEL=incidents
ZAMMAD_URL=https://tickets.$DOMAIN
ZAMMAD_TOKEN=$ZAMMAD_TOKEN
WIKI_URL=https://wiki.$DOMAIN
BAO_URL=https://bao.$DOMAIN
BAO_ROLE_ID=$BAO_ROLE_ID
BAO_SECRET_ID=$BAO_SECRET_ID
ICINGA_API_URL=https://icinga-api.$DOMAIN
ICINGA_API_USER=agent
ICINGA_API_PASSWORD=$(bg agentic-demo/icinga api_password)
EOF
ssh $SSH_OPTS "root@$AGENT_IP" "mkdir -p /opt/agent"
scp $SSH_OPTS "$AGENT_ENV" "root@$AGENT_IP:/opt/agent/.env"
rm -f "$AGENT_ENV" "$CORE_ENV"
ssh $SSH_OPTS "root@$AGENT_IP" "bash /opt/demo/agent/bootstrap.sh"

echo "==> done"
echo "chat:    https://chat.$DOMAIN"
echo "tickets: https://tickets.$DOMAIN"
echo "icinga:  https://icinga.$DOMAIN"
echo "wiki:    https://wiki.$DOMAIN"
echo "sso:     https://sso.$DOMAIN"
echo "bao:     https://bao.$DOMAIN"
echo "agent:   https://agent.$DOMAIN"
echo "site:    http://cust1.$DOMAIN"
