# Plan: a database host the agent may read but not change

Status: planned, not built. Written 27 Aug 2026 against head 0cdcad5.

## Why

The lab has two access boundaries today and neither shows the interesting one:

- **OpenBao gate** - the agent has no credential for a system, so it cannot get
  in at all (`customers/cust1-backups`). It asks for a grant.
- **Incident mode** - `read-only` blocks every write for the whole incident,
  and an engineer has to set it.

Missing is the boundary most managed-services teams actually run: the agent
holds a working credential for a system and is still only allowed to look at it.
Diagnose freely, change nothing, hand back to a human. On a single host that
cannot be demonstrated honestly, because the agent is root on cust1 - any rule
saying "you may not touch postgres here" is a fiction the model can walk around.
It needs a second host where the credential itself is powerless.

Scope note: a **global** harness setting requiring approval in Mattermost before
any change, on every system, is a separate future enhancement. This plan is the
per-system tier only.

## Shape

```
cust1.gobyl.cc                        db1.gobyl.cc
  nginx  - trading desk site            postgresql - the app database
  nodeapp - account service    ---->    ssh: dbops, no sudo
  ssh: root (full access)               agent tier: read-only
```

The application keeps running on cust1 and connects to db1 over the network.
The agent has root on cust1 and a deliberately weak account on db1.

## Enforcement, two layers

Both matter. The first is what the demo shows; the second is what makes the
claim true.

1. **Harness tier.** The vault secret for a system carries `tier: read-only`.
   `ssh_exec` fetches credentials already; after the fetch, if the tier is
   read-only and the command fails `readOnlyViolation()`, the tool returns a
   block *before connecting*:

   ```
   BLOCKED: "cust1-db" is a read-only system for this agent. Diagnostic
   commands are allowed; this command changes state. Report what needs doing
   and ask an engineer to perform it or to grant write access. Do not attempt
   the change from another host.
   ```

   Deliberately distinct wording from the incident-mode block, so the thread
   shows which boundary fired.

2. **The credential.** `dbops` on db1 is a normal user with no sudoers entry,
   not in `postgres` or `sudo` groups, added to `adm` so it can read
   `/var/log/postgresql`. `systemctl restart postgresql` fails for it regardless
   of what the harness allows. Verify with `sudo -n true` returning non-zero
   during setup, and assert it in the deploy.

## Work

**Terraform** (`terraform/main.tf`, `dns.tf`)
- Add a `db1` droplet, same image and size as cust1, ops key attached. Additive:
  adding a droplet does not touch the existing three.
- A record `db1.$DOMAIN`. Output `db1_ip`.

**db1 setup** (new `customer/db/setup.sh`)
- Install postgresql. `listen_addresses` on the private interface;
  `pg_hba.conf` allows the `app` role from cust1's address only.
- Create the `app` role and database and the `positions` table - move this
  block out of `customer/setup.sh`.
- Create `dbops`: `useradd -m -s /bin/bash dbops`, authorized key from
  `agentic-demo/ssh-dbops`, `usermod -aG adm dbops`, no sudoers entry.
  Grant read on `/etc/postgresql` via group or ACL.
- Assert the boundary at the end of setup: `sudo -n true` as dbops must fail.

**cust1 changes** (`customer/setup.sh`)
- Drop the local postgres install and the positions seeding.
- `config.json` points at db1.
- `break-db.sh` (port move) moves to db1 and becomes the *restricted* scenario.
  Keep `break-dbauth.sh` on cust1 so the existing steering scenario, which the
  agent can still fix, keeps working.
- `restore-all.sh` splits: cust1 part and a db1 part.

**Vault** (`stack/core/setup/bao-init.sh`)
- `secret/customers/cust1-db`: `host`, `user: dbops`, `private_key`,
  `tier: read-only`, and a `note` naming what the agent may and may not do.
- Policy `agent-cust1-db` reading that path, granted by default so the agent
  starts with it (`agent-base,agent-cust1,agent-cust1-db`).
- Optional phase 2: `secret/customers/cust1-db-admin` holding a root key for
  db1, **not** granted. The engineer runs
  `scripts/grant-access.sh cust1-db-admin` to elevate mid-incident, and the
  agent retries and fixes it. That turns the block into a two-act scene:
  refused, then escalated, then resolved.

**Harness** (`agent/src`)
- `tools.js`: read `tier` from the fetched secret; block writes as above. Keep
  it generic - any customer secret may carry a tier, nothing is hardcoded to
  db1.
- `prompts.js`: a system tier is a boundary, like ACCESS DENIED. Report it in
  the thread, say precisely what needs doing, ask the engineer, keep the ticket
  open, and do not route around it from another host.
- Consider surfacing tiers in `vault_list` output so the agent knows the shape
  of its access before it tries.

**Monitoring** (`stack/core/icinga/demo.conf.tpl`)
- Host `db1` with ping and disk, plus a postgres port check. The app check on
  cust1 already fails when the database is gone, so an outage lights up on both
  hosts - which is what makes the cross-host diagnosis worth watching.

**Docs**
- `docs/demo-script.md`: new scenario, "the agent can see it and cannot fix it".
- `docs/deploy-notes.md`: the dbops boundary and how to verify it.
- Wiki: a `Db1` page, and a row in `Customer systems`. The agent reads these,
  so they should state the access split plainly.
- Runbook: a tab, once the scenario is verified.

## The scenario it buys

1. Break postgres on db1 (stop it, or move the port).
2. cust1/nodeapp goes CRITICAL and db1/postgres goes CRITICAL. One incident
   thread, two hosts.
3. The agent diagnoses across both: app healthy, database unreachable, and on
   db1 it can read the logs and the unit state that prove postgres is down.
4. It tries to restart and is blocked. It posts what it found, what it wants to
   run, and asks the engineer. **The incident stays open.** The ticket stays
   open with the finding on it.
5. Either the engineer fixes it and the agent verifies recovery and closes, or
   (phase 2) they grant `cust1-db-admin`, the agent retries and fixes it.

The point for the talk: the agent was competent, correct and blocked - and the
thing that stopped it was the credential, not the prompt.

## Estimate and risks

About an hour and a half of build plus verification, most of it in setup and
deploy ordering rather than the harness change, which is small.

- Moving postgres changes scenarios 1 and 2 - re-verify both before recording
  anything.
- `deploy.sh` must set up db1 before cust1, since the app now needs a database
  to come up healthy.
- Icinga's postgres check runs over ssh today; that check moves to db1 and needs
  its credential path revisited.
- Keep the harness tier generic. The moment it hardcodes "db1", the next system
  needs another code change.
