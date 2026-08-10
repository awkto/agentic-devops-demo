# Demo runbook

## Before the demo

1. `scripts/deploy.sh` (about 20 minutes). Verify:
   - https://chat.gobyl.cc loads, login sysadmin / (OpenBao `agentic-demo/mattermost`)
   - https://icinga.gobyl.cc shows cust1 checks green
   - https://tickets.gobyl.cc loads
   - https://wiki.gobyl.cc has the Cust1 and Maintenance calendar pages
   - http://cust1.gobyl.cc serves the customer site
2. Log into Mattermost as alice or bob (password in `agentic-demo/demo-users`),
   open the Incidents channel.

## Scenario walkthrough

Pick a scenario, ssh to cust1 as root, run the break script, then narrate what
appears in Mattermost.

### 1. Website down (simple fix)

`/opt/break/break-website.sh`

Icinga flags the website check within a minute, the agent opens a ticket,
investigates, finds nginx stopped, starts it, verifies with a fresh HTTP check,
closes the ticket.

### 2. Disk full (cleanup with judgement)

`/opt/break/break-disk.sh`

Disk check goes critical. Agent finds /var/log/app-debug full of trace files,
checks the wiki (which documents this exact failure mode as safe to clean),
deletes old traces, verifies disk is back under threshold.

### 3. App crash-loop (real diagnosis)

`/opt/break/break-app.sh`

The node app dies with a missing config file. journalctl shows ENOENT. The wiki
documents where the config lives. Watch it find the file parked in /root and
restore it.

### 4. Database on wrong port (subtle)

`/opt/break/break-db.sh`

Postgres is up but on 5433, the app 500s. Good scenario to show engineer
steering: reply `read-only` in the thread, let it diagnose, then `go ahead`.

### 5. False alarm during maintenance

Edit the wiki Maintenance calendar page: add a row for cust1 with today's date
and a window covering now. Then run any break script. The agent should spot the
overlap, note it in the ticket and thread, and refuse to auto-remediate.

## Steering commands

Reply in the incident thread:

- `stop` interrupts the agent immediately
- `read-only` restricts ssh to diagnostic commands
- `read-write` or `go ahead` re-enables fixes
- anything else is passed to the agent as guidance

## After

`/opt/break/restore-all.sh` on cust1, close stray tickets, or just
`scripts/teardown.sh`.
