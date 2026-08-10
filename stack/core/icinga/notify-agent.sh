#!/bin/bash
# Icinga NotificationCommand: forward the alert to the agent harness.
# No jq dependency: the icinga2 image does not ship it.

esc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

payload=$(printf '{"source":"icinga","host":"%s","address":"%s","service":"%s","state":"%s","output":"%s","type":"%s"}' \
  "$(esc "$NOTIFY_HOST")" \
  "$(esc "$NOTIFY_HOST_ADDRESS")" \
  "$(esc "$NOTIFY_SERVICE")" \
  "$(esc "$NOTIFY_STATE")" \
  "$(esc "$NOTIFY_OUTPUT")" \
  "$(esc "$NOTIFY_TYPE")")

curl -fsS -m 10 -X POST "$AGENT_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $WEBHOOK_SECRET" \
  -d "$payload" || true
