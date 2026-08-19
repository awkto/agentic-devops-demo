# Next session

Start here. This is the plan for the next build round.

## Goal

Deploy the stack again and run the full demo end to end on an open model
(Qwen via Fireworks) instead of the Anthropic API.

## State

Tag `demo-v1` is the working version: Icinga and Zammad triggers, Mattermost
steering, session-resume follow-ups, `@agent` callouts. Validated end to end on
`claude-sonnet-5`, then torn down. Nothing is running. Keep `demo-v1` working as
the fallback during a live demo.

## Order of work

1. Issue #14, provider-agnostic loop. Do this before deploying. The Agent SDK
   speaks the Anthropic Messages API and Fireworks is OpenAI-compatible, so the
   model cannot be swapped by config today. About 70 lines of the 855 change.
   Session resume is the real work, see the issue.
2. `scripts/deploy.sh`. Idempotent, rerunning after a partial failure is the
   normal recovery path. Read `deploy-notes.md` first, particularly the Icinga
   version pins.
3. Run the scenarios in `runbook.md` against the open model. Confirm the steering
   commands and thread follow-ups still work, they depend on the new session
   persistence rather than the SDK's.

## Model

Benched 18 Aug 2026, full results in issue #7. Qwen 3.7/3.8, Kimi K2.6/K2.7/K3,
gpt-oss-120b and glm-5.2 all drive the incident loop correctly, including the
read-only and maintenance-standdown paths. Differences are verbosity, not
correctness. `qwen3p7-plus` was the leanest of the Qwen models, 15 tool calls to
fix and verify.

Bench any candidate before wiring it in:

```
FW_KEY=$(bao kv get -field=api_key agentic-demo/fireworks) \
  node agent/bench/loop.js accounts/fireworks/models/qwen3p7-plus full
```

Modes are `full`, `ro`, `maint`. Run all three.

Note for the on-prem story: the flagship Qwen and Kimi models are too large to
self-host on a single GPU droplet. gpt-oss-120b fits one H200 and scored well.
That is a separate decision from which model the demo runs on.

## Secrets

OpenBao mount `agentic-demo` at toke.dnsif.ca. `fireworks` holds the API key and
base URL. DigitalOcean tokens are at `kv/digitalocean/teamadf` (droplets) and
`kv/digitalocean/myteam` (the gobyl.cc DNS zone).

## Optional

Issues #10 to #13 are enhancements, not required for this round: sudo as the real
read-only boundary, maintenance owner callout, per-customer access tiers, ticket
history search. #10 pairs naturally with an open model, since read-only triage
plus handover is the scenario open models handled best.
