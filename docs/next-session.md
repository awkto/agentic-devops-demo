# Next session

Start here. This is the plan for the next round.

## Goal

Run #3: tweak from the dry-run lessons and, when ready, record the demo.

## State (19 Aug 2026)

Dry run #2 done, end to end on `qwen3p7-plus` via Fireworks. The stack is
STILL RUNNING on gobyl.cc (core/agent/cust1 droplets up, all Icinga checks
green, all agent tickets closed). Tear down with `scripts/teardown.sh` when
idle time gets expensive, redeploy with `MODEL_PROVIDER=fireworks
scripts/deploy.sh`.

Issue #14 (provider-agnostic loop) is done and validated live: the harness now
runs its own loop against any OpenAI-compatible endpoint when MODEL_BASE_URL
is set, with session transcripts under /opt/agent/sessions. The SDK path
remains the fallback (MODEL_BASE_URL empty), tag demo-v1 before that still
works too.

Everything in runbook.md passed on the open model: website, disk, app-crash,
db+steering (read-only, go ahead, stop, free text), thread follow-ups after
close, @agent mentions, and the Zammad customer-ticket path. Two harness
fixes came out of the run: repeat PROBLEM alerts now forward into the still
open thread instead of being dropped, and an engineer "stop" is recorded in
the transcript so a later resume knows it was interrupted.

## For run #3

1. Read docs/demo-script.md - it is the recording run-sheet, with timings and
   the behavior notes from the dry run. The main direction: the agent is fast
   (60-90 s per incident), so plan narration accordingly.
2. Rehearse scenario order and resets: restore-all, wait for green, quiet
   threads between takes, or re-breaks land in the old thread by design.
3. Optional polish before recording, none blocking:
   - Run the maintenance-standdown scenario live once (bench-passed only).
   - Issues #10-#13 remain the enhancement wishlist; #10 (sudo as the real
     read-only boundary) pairs best with the open-model story.
   - Consider muting the model's emoji in post_update via a system-prompt
     line if they bother you on camera.

## Model

`qwen3p7-plus` is wired in as the default for MODEL_PROVIDER=fireworks and
behaved well: correct on all paths, lean tool use, occasionally dramatic when
it smells a security issue (see demo-script behavior notes). Bench any
alternative with `agent/bench/turn.js` (drives the real production loop):

```
FW_KEY=$(bao kv get -field=api_key agentic-demo/fireworks) \
  node agent/bench/turn.js accounts/fireworks/models/<model> [full|ro|maint]
```

The older bench/loop.js is the standalone reference shape, kept for issue #7
context. Self-hosting note unchanged: gpt-oss-120b is the single-GPU target.

## Secrets

OpenBao mount `agentic-demo` at toke.dnsif.ca. `fireworks` holds the API key
and base URL. DigitalOcean tokens at `kv/digitalocean/teamadf` (droplets) and
`kv/digitalocean/myteam` (gobyl.cc DNS zone).
