#!/bin/bash
# Icinga NotificationCommand: forward the alert to the agent harness.
payload=$(jq -n \
  --arg host "$NOTIFY_HOST" \
  --arg address "$NOTIFY_HOST_ADDRESS" \
  --arg service "$NOTIFY_SERVICE" \
  --arg state "$NOTIFY_STATE" \
  --arg output "$NOTIFY_OUTPUT" \
  --arg type "$NOTIFY_TYPE" \
  '{source: "icinga", host: $host, address: $address, service: $service, state: $state, output: $output, type: $type}')

curl -fsS -m 10 -X POST "$AGENT_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $WEBHOOK_SECRET" \
  -d "$payload" || true
