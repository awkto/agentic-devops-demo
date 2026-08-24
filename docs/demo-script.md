# Demo script

One page to run the demo end to end: where to go, what to click, what to
expect. Scenario background is in runbook.md; this is the follow-along sheet.
Timings below are from the 19 Aug 2026 dry run on qwen3p7-plus via Fireworks.

## Before the audience arrives (about 30 minutes)

1. Deploy:

   ```
   MODEL_PROVIDER=fireworks scripts/deploy.sh     # Qwen via Fireworks
   scripts/deploy.sh                              # or the Anthropic fallback
   ```

   Takes about 17 minutes. Requires terraform, bao (authenticated), jq, rsync.

2. Verify every service answers:

   | Check | Expect |
   |---|---|
   | https://chat.gobyl.cc | Mattermost login page |
   | https://icinga.gobyl.cc | login, then all cust1 checks green (allow ~2 min after deploy) |
   | https://tickets.gobyl.cc | Zammad login page |
   | https://wiki.gobyl.cc | wiki with Cust1 and Maintenance calendar pages |
   | http://cust1.gobyl.cc | customer status dashboard |

3. Logins. Passwords all live in OpenBao (`bao kv get agentic-demo/<path>`):

   | Service | User | Password field |
   |---|---|---|
   | Mattermost (admin) | sysadmin | `mattermost` admin_password |
   | Mattermost (demo engineer) | alice or bob | GitLab button, then `demo-users` password at Keycloak |
   | Zammad | admin@gobyl.cc | `zammad` admin_password |
   | Icinga | icingaadmin | `icinga` admin_password |
   | MediaWiki | Admin | `mediawiki` admin_password |

4. Open two windows side by side:
   - Browser: Mattermost as **alice**, Incidents channel. Optionally tabs for
     Zammad and Icinga to show tickets and alerts as they happen.
   - Terminal: ssh to cust1 as root for the break scripts:

     ```
     bao kv get -field=private_key agentic-demo/ssh-ops > /tmp/ops && chmod 600 /tmp/ops
     ssh -i /tmp/ops root@cust1.gobyl.cc
     ```

## Scenario 1: website down (the opener, simple fix)

- Do: `/opt/break/break-website.sh` on cust1.
- Watch: the Icinga alert lands and the incident thread plus Zammad ticket
  appear within 30-60 seconds.
- Expect in the thread: maintenance-calendar and open-ticket check, nginx found
  stopped, config validated, service restarted, verified with a fresh HTTP
  check, ticket closed with a summary. About 30 seconds of thread activity,
  then the Icinga recovery confirmation ~30 s later.
- Show: http://cust1.gobyl.cc is back; the closed ticket in Zammad.

## Scenario 2: engineer steering (db on wrong port)

- Do: `/opt/break/break-db.sh`, and as soon as the thread appears reply
  `read-only` in it. Be quick: the agent moves fast, steer within ~30 s.
- Expect: "Mode set to read-only." Diagnosis in ~30 s (postgres on 5433, app
  expects 5432) ending in a recommended plan, not a fix. If the model tries a
  write anyway, the harness blocks it and the agent visibly backs off —
  that is the enforcement boundary working; point it out.
- Then reply `go ahead`.
- Expect: fix applied, verified, ticket closed, ~20 s.
- Also worth showing: `stop` in any thread kills the session immediately.
  Note: whatever was broken stays broken — restore by hand afterwards.

## Scenario 3: follow-up questions (session memory)

In a closed thread from an earlier scenario, reply:

- "which exact commands did you run?"
- "show me the log lines that pointed at the cause"

Expect: an answer in ~5-10 s from the same session with full memory of what it
saw and did. Transcripts persist on disk, so this survives harness restarts.

## Scenario 4: channel Q&A

Top-level post in Incidents: `@agent list the tickets from the last 24 hours
and how each was resolved`.

Expect: a fresh thread answering in ~10 s with an accurate per-ticket summary
pulled from Zammad, including incidents it just handled.

## Scenario 5: customer ticket (forensics, no break needed)

File a ticket in Zammad as any customer: "Our staff say the dashboard felt
slow and errored between X and Y today, is everything healthy now?" (use a
window where earlier scenarios actually ran).

Expect: the agent picks the ticket up, checks current health, digs through
host logs for the reported window, correlates it to the real earlier outage,
and closes the ticket with root cause, impact, and a recommendation. ~60 s.

## Scenario 6 (optional): maintenance standdown

- Do: edit the wiki "Maintenance calendar" page, add a cust1 row with a window
  covering now. Run any break script.
- Expect: the agent spots the overlap, notes it in ticket and thread, and does
  not remediate. (Validated on the bench for qwen3p7-plus; run it once before
  recording if you plan to show it live.)
- Clean up the wiki row afterwards.

## Scenario 7: access grant at the vault (OpenBao gate)

The agent's vault role is only granted cust1's main credentials; the backup
account (`customers/cust1-backups`) exists but is not granted.

- Do: top-level post `@agent check that the nightly database snapshots on
  cust1's backup account are current`.
- Expect: the agent hits ACCESS DENIED in OpenBao, reports in the thread that
  it has no grant for that system, and asks for access instead of treating it
  as an outage.
- Do: on the operator machine run `scripts/grant-access.sh cust1-backups`,
  then reply in the thread "access granted, try again".
- Expect: the agent re-reads the secret (fresh login picks up the policy),
  sshes in as the backup user, lists /home/backup/snapshots, and reports
  snapshot freshness.
- Clean up: `scripts/grant-access.sh cust1-backups revoke`. Grants also reset
  on every redeploy.

## SSO logins (issue #6, partial)

Keycloak (realm `demo`, users sysadmin/alice/bob, demo-users password) now
signs you into: Zammad (button "SSO" on the login page), Mattermost (GitLab
button - Team Edition shim), and OpenBao (OIDC method in the UI login).
Icinga and the wiki are still local login. Password login works everywhere
regardless, so SSO failing never blocks the demo.

## Behavior notes from the dry run (qwen3p7-plus)

- It is fast: a routine incident is fully resolved 60-90 s after the break
  script runs. Keep the narration ready before you break things.
- If the same service breaks again while the previous thread is still in its
  idle window (15 min), the new alert lands in the same thread as
  "CRITICAL again" instead of opening a new incident. Between takes, prefer
  `restore-all.sh`, wait for Icinga green, and let threads go quiet.
- Wait for Icinga to show green before re-breaking the same service; if it
  never saw the recovery, no new notification fires and the agent stays idle.
- Repeated manual breaks of the same service make the agent suspicious: on the
  third website stop it flagged the ssh logins as a possible security issue
  and escalated instead of quietly re-fixing. A thread reply "that was
  authorized break-testing, stand down" resolves it gracefully - or treat it
  as a feature and show it off.
- Cosmetics: Qwen sprinkles emoji into updates and occasionally posts its
  final summary twice. Harmless.

## If the model misbehaves mid-demo

Fall back to Anthropic without redeploying: on the agent droplet
(`ssh -i /tmp/ops root@agent.gobyl.cc`) edit `/opt/agent/.env`, set
`MODEL_BASE_URL=` (empty) and `AGENT_MODEL=claude-sonnet-5`, then
`systemctl restart agentd`. Active threads die but new incidents work; tag
demo-v1 is the same code path.

## Reset between runs

- `/opt/break/restore-all.sh` on cust1, wait for Icinga to go green.
- Close stray tickets in Zammad if the agent left any open.
- Full teardown after the demo: `scripts/teardown.sh`.
