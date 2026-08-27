# agentic-devops-demo

Sandbox environment that shows an AI agent working ops incidents end to end.

An Icinga alert or Zammad ticket triggers the agent. It files a ticket, announces
itself in Mattermost, checks the wiki and open tickets for planned maintenance,
pulls SSH credentials from OpenBao, investigates the customer host, fixes the
problem if it is routine, and reports back with a summary. Engineers can steer it
from the Mattermost thread: stop it, restrict it to read-only, or point it in a
different direction.

## Components

| Piece | Runs on | What |
|---|---|---|
| Mattermost, Keycloak, Zammad, Icinga, MediaWiki, OpenBao | core droplet | docker compose behind Caddy |
| Agent harness | agent droplet | Node service on the Claude Agent SDK |
| Customer host | cust1 droplet | nginx site, node app, postgres, fault injection scripts |

## Layout

- `terraform/` droplets, DNS, firewall
- `stack/core/` compose stack plus first-run setup scripts
- `customer/` customer host setup, app, break scenarios
- `agent/` the harness: webhook receiver, agent loop, tools
- `scripts/` deploy and teardown
- `docs/` demo runbook

## Deploy

Needs terraform, jq, rsync, and an authenticated `bao` CLI. Secrets live in an
OpenBao kv mount `agentic-demo` (service passwords, SSH keys, API key) plus
DigitalOcean tokens at `kv/digitalocean/{teamadf,myteam}`.

```
scripts/deploy.sh
scripts/teardown.sh
```

To reach the hosts as yourself rather than with the generated ops key, store
your public key once and every deploy authorizes it on all three droplets:

```
bao kv put agentic-demo/ssh-operator public_key="$(cat ~/.ssh/id_ed25519.pub)"
```

## Demo scenarios

On cust1, as root:

- `/opt/break/break-website.sh` stops nginx
- `/opt/break/break-disk.sh` fills the disk with debug logs
- `/opt/break/break-app.sh` removes the app config, causing a crash-loop
- `/opt/break/break-db.sh` moves postgres to the wrong port
- `/opt/break/restore-all.sh` resets everything

Watch the Incidents channel in Mattermost. Reply in the incident thread with
`stop`, `read-only`, `read-write`, or free-text guidance.

See `docs/runbook.md` for the full walkthrough and `docs/deploy-notes.md` for
version pins and setup gotchas before changing anything. `docs/next-session.md`
is the plan for the next build round.
