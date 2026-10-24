#!/bin/bash
# Destroys the droplets, firewall and ssh key. DNS records live in terraform/dns
# (separate state) and are kept on purpose, so resolvers never cache NXDOMAIN.
set -euo pipefail
cd "$(dirname "$0")/.."

bg() { bao kv get -format=json "$1" | jq -r ".data.data.$2"; }

export TF_VAR_do_token_team=$(bg kv/digitalocean/teamadf token)
export TF_VAR_ops_ssh_public_key=$(bg agentic-demo/ssh-ops public_key)
export TF_VAR_agent_ssh_public_key=$(bg agentic-demo/ssh-agent public_key)

(cd terraform && terraform destroy -auto-approve)
