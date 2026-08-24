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

- Two loop implementations, selected by config (issue #14). `MODEL_BASE_URL`
  set: the harness's own loop (src/oaichat.js) against any OpenAI-compatible
  endpoint, authenticated with `MODEL_API_KEY`. Empty: the original Claude
  Agent SDK path, which reads ANTHROPIC_API_KEY. `deploy.sh` picks via
  `MODEL_PROVIDER=fireworks|anthropic` (default anthropic); `AGENT_MODEL`
  overrides the model either way. Switching a live deployment = edit
  /opt/agent/.env, restart agentd.
- Session resume differs per path. SDK: CLI session files under HOME/.claude.
  Own loop: full message arrays under /opt/agent/sessions/<id>.json. Both map
  Mattermost root posts to session ids via /opt/agent/state.json. Sessions do
  not survive a provider switch: the id resolves to nothing on the other side,
  so the follow-up starts a fresh context (degrades, does not break).
- The Agent SDK spawns the bundled Claude Code CLI, which refuses
  bypassPermissions as root. The service runs as user `agentd` with
  HOME=/opt/agent (only the SDK path needs this, but keep the dedicated user).
- @anthropic-ai/claude-agent-sdk 0.3.x requires zod 4. The own loop derives its
  OpenAI tool schemas from the same zod shapes via z.toJSONSchema (zod 4).
- bootstrap.sh's rsync excludes .env, state.json, .claude and sessions so
  redeploys keep resumability.
- Mention and incident sessions run concurrently and do not share state; a
  channel summary asked mid-incident may describe a fix still in flight.

## MediaWiki

- Installed with `php maintenance/run.php install` on first boot; pages seeded
  from stack/core/wiki/pages via `maintenance/run.php edit` reading stdin.
  /var/www/html is a named volume so LocalSettings.php persists.

## Access gate (issue #17)

- The agent authenticates to the sandbox OpenBao with an AppRole
  (`auth/approle/role/agent`); `bao-init.sh` writes role_id/secret_id to
  /opt/demo/state and deploy.sh puts them in the agent .env as
  BAO_ROLE_ID/BAO_SECRET_ID. BAO_TOKEN still works as a legacy fallback.
- Grants are policies on the role: `agent-base` (list customers) and
  `agent-cust1` attached by default; `agent-cust1-backups` exists unattached
  as the demo's restricted system. `scripts/grant-access.sh <system>
  [grant|revoke]` edits the role from the operator machine.
- A grant only shows up on a fresh token, so the harness re-logs-in when it
  sees 403 and retries once; a still-denied read returns an ACCESS DENIED
  string to the model (fail closed, never a thrown tool error).
- OpenBao runs in dev mode (in-memory): every deploy reseeds policies and
  role, so grants do not survive a redeploy. That includes reverting any
  live-granted access - by design for a demo.
- The restricted target is a real account: user `backup` on cust1 with
  snapshot fixtures in /home/backup/snapshots, reachable with the agent key
  (deploy.sh passes AGENT_PUB into customer/setup.sh).

## SSO (issue #6, partial)

- Keycloak realm template now carries three clients: `openbao` (OIDC),
  `mattermost` (OIDC posing as GitLab), and the Zammad SAML client. Client
  secret comes from the operator vault: `agentic-demo/keycloak
  oidc_client_secret` - **deploy fails on a missing field**, create it once
  with `bao kv patch agentic-demo/keycloak oidc_client_secret=$(openssl rand
  -hex 24)`.
- OpenBao: `bao-init.sh` enables the `oidc` auth method against the realm
  (role `engineer`, policies `engineers`). Login via the UI's OIDC method.
  Non-fatal if Keycloak is not up yet.
- Zammad: SAML enabled by `zammad-init.sh`, which pulls the IdP cert from the
  live realm SAML descriptor (needs the sso vhost certed, i.e. runs after
  Caddy has issued certs). Users auto-create on first SSO login. Local login
  stays. The inner zammad-nginx must send `X-Forwarded-Proto https`
  (`NGINX_SERVER_SCHEME=https` in zammad-override.yml) or Rails rejects the
  SAML kickoff POST with InvalidAuthenticityToken - it sees plain http from
  Caddy and fails the origin check.
- Mattermost Team Edition has no real OIDC; the GitLab login is plain OAuth2
  pointed at the realm endpoints, with Keycloak mappers shaping the userinfo
  into GitLab's user JSON (numeric `id` from the gitlab_id user attribute,
  `username`). Two traps, verified 24 Aug 2026:
  - GitLabSettings.Scope must NOT contain `openid` - Mattermost substring-
    matches it and routes to the enterprise-only OpenID provider, so the
    GitLab button 501s ("Gitlab SSO through OAuth 2.0 not available").
    Keep Scope empty.
  - Keycloak 24+ refuses userinfo unless the access token carries the openid
    scope, which Mattermost therefore cannot request. mattermost-init.sh
    creates a client scope literally named `openid` and attaches it as a
    default scope on the mattermost client, so tokens carry it unrequested.
  mmctl writes the container's config.json (not on a volume): settings are
  reapplied by mattermost-init.sh on each deploy but vanish if the container
  is recreated without rerunning it. Mattermost refuses SSO logins for
  existing password accounts with the same email, so mattermost-init.sh flips
  alice/bob to gitlab auth in the DB (authdata = realm gitlab_id); sysadmin
  stays on password as the admin fallback.
- Still local-only: MediaWiki (needs PluggableAuth+OIDC extensions baked into
  the image) and Icinga Web 2 (needs an oauth2-proxy in front with external
  auth). Tracked in issue #6.
