# Deploy notes

Hard-won details from the first build. Read this before changing versions or
rerunning setup scripts. The full history is in the GitLab tracking project
(gitlab.dnsif.ca/github/agentic-devops-demo) issue notes.

## Accounts and secrets

- The DNS zone (gobyl.cc) lives in a different DigitalOcean account than the
  droplets. Terraform uses two providers: `do_token_team` for droplets,
  `do_token_dns` for records. Tokens come from OpenBao `kv/digitalocean/teamadf`
  and `kv/digitalocean/myteam`.
- Everything else lives in the OpenBao kv-v2 mount `agentic-demo`. The deploy
  script writes two generated tokens back (`mattermost-bot`, `zammad-api`);
  they are recreated on every fresh deploy, stale values are harmless.
- `scripts/deploy.sh` is idempotent. Rerunning after a partial failure is the
  normal recovery path.

## Icinga

Version alignment matters. Known-good set (pinned in the compose file):
icinga2 2.16, icingadb 1.5, icingaweb2 2.14.

- icingaweb2 2.12 image ships PHP 8.4, whose bundled LESS compiler fatals
  ("Attempt to read property name on null") so all CSS 500s.
- icinga2 2.14 writes booleans to Redis as 0/1 but icingadb-web 1.4 expects
  y/n ("Expected y or n, got 0"). icinga2 2.16 matches.
- icingadb 1.5 needs schema v7. It migrates an empty database fine; if
  upgrading from an older daemon, drop and recreate the icingadb database
  (throwaway demo data).
- Module config env vars use the prefix `icingaweb.modules.icingadb.*`, not
  `icingaweb.icingadb.*`. The wrong prefix creates ini files in the wrong
  directory and the module reports "Database not configured".
- Everything icinga assumes Redis on 6380 by default; we run plain redis:7 on
  6379, so the port is set explicitly in three places: the IcingaDB feature
  object (icinga-init.sh), the icingadb daemon env, and the web module env.
- The icinga2 image has curl, ssh and monitoring-plugins but no jq, hence the
  jq-free notify-agent.sh. Config, scripts and the ssh key live in the /data
  volume so they survive container recreation; apt-installed extras do not.
- icinga-init.sh removes the default conf.d/hosts.conf (noisy self-checks on
  the container).
- The API (port 5665, self-signed TLS) is exposed via the Caddy vhost
  icinga-api.<domain> with tls_insecure_skip_verify; the agent uses ApiUser
  "agent".

## Zammad

- Deployed by cloning zammad/zammad-docker-compose and joining zammad-nginx to
  the shared external docker network `demo` (see zammad-override.yml).
- Rails commands inside the container need `bundle exec rails r ...`; plain
  `rails` is not on PATH.
- The admin API user must be granted group access explicitly
  (`group_names_access_map = { 'Users' => 'full' }`) or ticket creation
  returns 403 even with an admin token.
- Outbound webhooks cannot send custom headers; the trigger webhook
  authenticates with basic auth instead, and the harness accepts either the
  shared-secret header or basic auth.
- The agent's own tickets are prefixed `[icinga]`; the harness ignores webhook
  deliveries for them.

## Mattermost

- `mmctl --local token generate ... --json` returns an array, not an object.
- Bot posting, websocket auth and channel reads all work with a plain user
  account plus personal access token (Team Edition, no bot API needed).

## Agent harness

- The Agent SDK spawns the bundled Claude Code CLI, which refuses
  bypassPermissions as root. The service runs as user `agentd` with
  HOME=/opt/agent.
- @anthropic-ai/claude-agent-sdk 0.3.x requires zod 4.
- Session resume: the CLI stores session files under HOME/.claude, and the
  harness maps Mattermost root posts to session ids in /opt/agent/state.json.
  bootstrap.sh's rsync excludes .env, state.json and .claude so redeploys keep
  resumability.
- Mention and incident sessions run concurrently and do not share state; a
  channel summary asked mid-incident may describe a fix still in flight.

## MediaWiki

- Installed with `php maintenance/run.php install` on first boot; pages seeded
  from stack/core/wiki/pages via `maintenance/run.php edit` reading stdin.
  /var/www/html is a named volume so LocalSettings.php persists.
