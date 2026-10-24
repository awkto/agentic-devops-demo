import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config.js';
import * as zammad from './zammad.js';
import * as icinga from './icinga.js';
import * as alerts from './alerts.js';
import * as activity from './activity.js';
import { threadUrl } from './mattermost.js';
import * as settings from './settings.js';

const execFileP = promisify(execFile);

// Commands allowed while the incident is in read-only mode. First word must
// match, and no write-ish constructs may appear anywhere in the command.
const READ_CMDS = new Set([
  'cat', 'ls', 'df', 'du', 'free', 'ps', 'journalctl', 'systemctl', 'tail',
  'head', 'grep', 'ss', 'netstat', 'uptime', 'curl', 'id', 'whoami', 'w',
  'last', 'dmesg', 'find', 'stat', 'wc', 'env', 'hostname', 'ip', 'date',
  'echo', 'sort', 'uniq', 'cut', 'tr', 'pg_isready', 'nginx', 'node', 'which', 'file', 'lsof', 'mount',
]);
// A read-only profile gets the allowlist applied to every command in a chain,
// and the diagnostic commands that can still change things are narrowed.
const STRICT_PATTERNS = /\bfind\b.*\s-(delete|exec|ok)|\bcurl\b.*\s(-X|--request|-d|--data\S*|-T|--upload-file|-F)\b|\bnginx\s+-s\b|\$\(/;
const WRITE_PATTERNS = /[><`]|\brm\b|\bmv\b|\bcp\b|\bdd\b|\bkill\b|\bpkill\b|\bshutdown\b|\breboot\b|\btruncate\b|\bfallocate\b|\bchmod\b|\bchown\b|\btee\b|\bsed\s+-i\b|\bapt\b|\bapt-get\b|systemctl\s+(start|stop|restart|reload|mask|unmask|enable|disable)\b|\bmkdir\b|\btouch\b|\buseradd\b|\bpasswd\b/;

// Tools with side effects take none|read|write; the rest only none|read.
// A profile in read-only mode reads on every side-effect tool by default.
export const SIDE_EFFECT_TOOLS = ['ssh_exec', 'update_ticket', 'post_update'];
export const toolLevel = (profile, tool) => {
  const set = settings.toolLevels(profile)[tool];
  if (set) return set;
  if (!SIDE_EFFECT_TOOLS.includes(tool)) return 'read';
  return settings.profile(profile)?.mode === 'read-only' ? 'read' : 'write';
};
export const toolLevelOptions = (tool) => (SIDE_EFFECT_TOOLS.includes(tool) ? ['none', 'read', 'write'] : ['none', 'read']);
// Read level on a side-effect tool reuses the read-only enforcement below.
const readOnlyFor = (incident, tool) => toolLevel(incident.profile, tool) === 'read';

function strictViolation(command) {
  if (readOnlyViolation(command) || STRICT_PATTERNS.test(command)) return true;
  return command.split(/&&|\|\||[;|\n]/).some((seg) => {
    const w = seg.trim().split(/\s+/)[0];
    return w && (!READ_CMDS.has(w) || w === 'node');
  });
}

function readOnlyViolation(command) {
  if (WRITE_PATTERNS.test(command)) return true;
  const first = command.trim().split(/\s+/)[0];
  return !READ_CMDS.has(first);
}

// The agent authenticates to OpenBao with its own AppRole; its token only
// carries the policies an engineer has granted. A 403 therefore means "not
// granted", not an error: re-login once (a fresh grant only shows up on a new
// token), then fail closed with a message the model can act on. BAO_TOKEN is
// the legacy static-token path, kept for old deployments.
class BaoDenied extends Error {
  constructor(secretPath) {
    super(`openbao access to ${secretPath} not granted`);
    this.secretPath = secretPath;
  }
}

const deniedMessage = (secretPath) =>
  `ACCESS DENIED: OpenBao has not granted this agent access to "${secretPath}". ` +
  'An engineer can grant it (attach the matching policy to the agent role in OpenBao). ' +
  'Report this in the thread and ask for access; once granted, simply retry.';

let baoToken = config.bao.token || null;

async function baoLogin() {
  const res = await fetch(`${config.bao.url}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: config.bao.roleId, secret_id: config.bao.secretId }),
  });
  if (!res.ok) throw new Error(`openbao approle login failed: ${res.status}`);
  baoToken = (await res.json()).auth.client_token;
}

async function baoFetch(secretPath, { list = false } = {}) {
  // Docs and vault CLI output write paths as "secret/customers/cust1"; the
  // API mounts kv-v2 data/metadata under the mount name. Accept either form
  // so a model quoting the wiki verbatim does not get a bogus ACCESS DENIED.
  secretPath = secretPath.replace(/^\/+/, '').replace(/^secret\/(data\/|metadata\/)?/, '');
  const url = `${config.bao.url}/v1/secret/${list ? 'metadata' : 'data'}/${secretPath}${list ? '?list=true' : ''}`;
  const get = () => fetch(url, { headers: { 'X-Vault-Token': baoToken } });
  if (!baoToken && config.bao.roleId) await baoLogin();
  let res = await get();
  if ((res.status === 403 || res.status === 401) && config.bao.roleId) {
    await baoLogin();
    res = await get();
  }
  if (res.status === 403) throw new BaoDenied(secretPath);
  if (!res.ok) throw new Error(`openbao ${list ? 'list' : 'read'} ${secretPath}: ${res.status}`);
  return res.json();
}

async function baoRead(secretPath) {
  return (await baoFetch(secretPath)).data.data;
}

async function baoList(secretPath) {
  return (await baoFetch(secretPath, { list: true })).data.keys;
}

// Provider-neutral tool registry. Each entry is a zod shape plus a handler
// returning a plain string; buildOpsServer() wraps the set for the Claude
// Agent SDK, openaiToolSchemas()/runTool() expose the same set to the
// OpenAI-compatible loop. incident supplies postUpdate() and state {mode, ticketId}.
const defs = [
  {
    name: 'post_update',
    description:
      'Post a short status update to the incident thread in Mattermost. Use this before and after each ' +
      'significant step so engineers can follow along. Pass thread_id to post into a different thread ' +
      'instead - use that to tell an engineer in an earlier thread that their request has caused an alert.',
    shape: { message: z.string(), thread_id: z.string().optional() },
    run: async (incident, { message, thread_id }) => {
      if (thread_id && thread_id !== incident.rootId && readOnlyFor(incident, 'post_update')) {
        return 'BLOCKED: this agent has read-only access to post_update, it may only post in its own thread.';
      }
      const refused = incident.guardPost(message, thread_id);
      if (refused) return refused;
      await incident.postUpdate(message, thread_id);
      return thread_id ? `posted to thread ${thread_id}` : 'posted';
    },
  },

  {
    name: 'recent_agent_activity',
    description:
      'What you yourself have done recently in other threads (default last 4 hours): sessions opened and ' +
      'updates posted, with their thread ids. Each incident runs in its own session with its own memory, ' +
      'so this is the only way to see that an outage you are looking at may be work an engineer asked you ' +
      'for a few minutes ago in another thread. Check it before treating an alert as an unexplained fault.',
    shape: { hours: z.number().optional(), limit: z.number().optional() },
    run: async (incident, { hours, limit }) => {
      const res = activity.recent({
        hours: hours ?? 4,
        limit: limit ?? 60,
        excludeThread: incident.rootId || undefined,
      });
      for (const [id, t] of Object.entries(res.threads)) t.url = threadUrl(id);
      return JSON.stringify(res);
    },
  },

  {
    name: 'get_wiki_page',
    description: 'Fetch the raw wikitext of a documentation page, preceded by its canonical URL (link to it with that URL). Useful pages: "Customer systems", "Cust1", "Maintenance calendar", "Process incident response".',
    shape: { title: z.string() },
    run: async (_incident, { title }) => {
      // Resolve the real title (case, redirects) so the URL we hand out works.
      const q = new URLSearchParams({ action: 'query', titles: title, redirects: '1', format: 'json' });
      const info = await fetch(`${config.wiki.url}/api.php?${q}`);
      const page = info.ok && Object.values((await info.json()).query?.pages || {})[0];
      if (!page || page.missing !== undefined || page.invalid !== undefined) return `page not found: ${title}`;
      const t = encodeURIComponent(page.title.replace(/ /g, '_'));
      const res = await fetch(`${config.wiki.url}/index.php?title=${t}&action=raw`);
      if (!res.ok) return `page not found: ${title}`;
      return `URL: ${config.wiki.url}/index.php/${t}\n\n${await res.text()}`;
    },
  },

  {
    name: 'vault_list',
    description: 'List entries under a path in OpenBao, e.g. "customers".',
    shape: { path: z.string() },
    run: async (_incident, { path: p }) => {
      try {
        return JSON.stringify(await baoList(p));
      } catch (err) {
        if (err instanceof BaoDenied) return deniedMessage(p);
        throw err;
      }
    },
  },

  {
    name: 'vault_read',
    description: 'Read a secret from OpenBao, e.g. "customers/cust1". Private key material is redacted; ssh_exec uses it automatically.',
    shape: { path: z.string() },
    run: async (_incident, { path: p }) => {
      let data;
      try {
        data = await baoRead(p);
      } catch (err) {
        if (err instanceof BaoDenied) return deniedMessage(p);
        throw err;
      }
      const safe = {};
      for (const [k, v] of Object.entries(data)) {
        safe[k] = /private_key|password|secret/i.test(k) ? '(redacted, used automatically)' : v;
      }
      return JSON.stringify(safe);
    },
  },

  {
    name: 'ssh_exec',
    description:
      'Run a shell command on a customer host over ssh. Credentials are fetched from OpenBao ' +
      '(secret/customers/<name>). In read-only mode only diagnostic commands are allowed. Some ' +
      'systems carry tier "read-only" on their vault secret: on those, write commands are always ' +
      'blocked, whatever the incident mode.',
    shape: { customer: z.string().describe('customer name, e.g. cust1'), command: z.string() },
    run: async (incident, { customer, command }) => {
      if (readOnlyFor(incident, 'ssh_exec') && strictViolation(command)) {
        return `BLOCKED: this agent has read-only access to ssh_exec, command not allowed: ${command}`;
      }
      if (incident.state.mode === 'read-only' && readOnlyViolation(command)) {
        return `BLOCKED: incident is in read-only mode, command not on the diagnostic allowlist: ${command}`;
      }
      let creds;
      try {
        creds = await baoRead(`customers/${customer}`);
      } catch (err) {
        if (err instanceof BaoDenied) return deniedMessage(`customers/${customer}`);
        throw err;
      }
      // Per-system tier, independent of the incident mode: a read-only system
      // never accepts a write from this agent, even mid read-write incident.
      if (creds.tier === 'read-only' && readOnlyViolation(command)) {
        return (
          `BLOCKED: "${customer}" is a read-only system for this agent. Diagnostic commands are ` +
          'allowed; this command changes state. Report what needs doing and ask an engineer to ' +
          'perform it or to grant write access. Do not attempt the change from another host.'
        );
      }
      const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-key-'));
      const keyFile = path.join(keyDir, 'id');
      try {
        fs.writeFileSync(keyFile, creds.ssh_private_key.endsWith('\n') ? creds.ssh_private_key : creds.ssh_private_key + '\n', { mode: 0o600 });
        const { stdout, stderr } = await execFileP('ssh', [
          '-i', keyFile,
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ConnectTimeout=10',
          `${creds.ssh_user}@${creds.host}`,
          command,
        ], { timeout: 60000, maxBuffer: 512 * 1024 });
        const out = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        return out.slice(0, 20000) || '(no output)';
      } catch (err) {
        const out = [err.stdout, err.stderr, `exit: ${err.code ?? 'timeout'}`].filter(Boolean).join('\n');
        return out.slice(0, 20000);
      } finally {
        fs.rmSync(keyDir, { recursive: true, force: true });
      }
    },
  },

  {
    name: 'list_open_tickets',
    description: 'List open Zammad tickets, to spot known work in progress. Each has a url to link to.',
    shape: {},
    run: async () => JSON.stringify(await zammad.listOpen()),
  },

  {
    name: 'icinga_status',
    description: 'Current state of all monitored services: state, acknowledged, in_downtime, since, last output.',
    shape: {},
    run: async () => JSON.stringify(await icinga.serviceStatus()),
  },

  {
    name: 'icinga_alert_history',
    description:
      'Past alerts from monitoring: every PROBLEM and RECOVERY notification in the last N hours ' +
      '(default 24), newest first, plus per service how many times it broke, when it last broke ' +
      'and recovered, and how long each outage lasted. Optionally filter by service, e.g. "cust1/website". ' +
      'Use it to tell a first failure apart from a repeat.',
    shape: {
      service: z.string().optional(),
      hours: z.number().optional(),
      limit: z.number().optional(),
    },
    run: async (_incident, { service, hours, limit }) =>
      JSON.stringify(alerts.history({ service, hours: hours ?? 24, limit: limit ?? 50 })),
  },

  {
    name: 'zammad_recent_tickets',
    description: 'List tickets updated within the last N hours (default 24), any state. Each has a url to link to.',
    shape: { hours: z.number().optional() },
    run: async (_incident, { hours }) => JSON.stringify(await zammad.listRecent(hours ?? 24)),
  },

  {
    name: 'zammad_ticket_articles',
    description: 'Full note history of a ticket by id: who wrote what and when. Use to summarize how an incident was resolved.',
    shape: { ticket_id: z.number() },
    run: async (_incident, { ticket_id }) => JSON.stringify(await zammad.getArticles(ticket_id)),
  },

  {
    name: 'update_ticket',
    description: 'Add a note to the incident Zammad ticket, optionally changing its state (open, closed).',
    shape: { note: z.string(), state: z.enum(['open', 'closed']).optional() },
    run: async (incident, { note, state }) => {
      if (readOnlyFor(incident, 'update_ticket')) return 'BLOCKED: this agent profile has read-only access to tickets, it cannot update or close tickets.';
      if (!incident.state.ticketId) return 'no ticket attached to this incident';
      await zammad.addNote(incident.state.ticketId, note);
      if (state) await zammad.setState(incident.state.ticketId, state);
      return `ticket updated: ${zammad.ticketUrl(incident.state.ticketId)}`;
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

export const toolNames = defs.map((d) => d.name);
const offered = (incident) => defs.filter((d) => toolLevel(incident.profile, d.name) !== 'none');

export function buildOpsServer(incident) {
  const tools = offered(incident).map((d) =>
    tool(d.name, d.description, d.shape, async (args) =>
      text(await incident.auditedTool(d.name, args).catch((err) => `tool error: ${err.message}`)))
  );
  return createSdkMcpServer({ name: 'ops', version: '1.0.0', tools });
}

export const allowedToolNames = defs.map((d) => `mcp__ops__${d.name}`);

export function openaiToolSchemas(incident) {
  return offered(incident).map((d) => {
    const { $schema, ...parameters } = z.toJSONSchema(z.object(d.shape));
    return { type: 'function', function: { name: d.name, description: d.description, parameters } };
  });
}

export async function runTool(incident, name, args) {
  if (!settings.isEnabled(incident.profile)) return 'BLOCKED: agent disabled by admin. Do not run any more tools; stop and wait.';
  const d = defs.find((t) => t.name === name);
  if (!d) return `unknown tool: ${name}`;
  if (toolLevel(incident.profile, name) === 'none') return `BLOCKED: an admin has removed ${name} from this agent. You have no access to it. Do not get the same information another way (no ssh, curl or other tools as a workaround); tell the engineer you have no access to ${name} and stop.`;
  const parsed = z.object(d.shape).safeParse(args ?? {});
  if (!parsed.success) return `invalid arguments for ${name}: ${parsed.error.message}`;
  return d.run(incident, parsed.data);
}
