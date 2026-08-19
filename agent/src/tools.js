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

const execFileP = promisify(execFile);

// Commands allowed while the incident is in read-only mode. First word must
// match, and no write-ish constructs may appear anywhere in the command.
const READ_CMDS = new Set([
  'cat', 'ls', 'df', 'du', 'free', 'ps', 'journalctl', 'systemctl', 'tail',
  'head', 'grep', 'ss', 'netstat', 'uptime', 'curl', 'id', 'whoami', 'w',
  'last', 'dmesg', 'find', 'stat', 'wc', 'env', 'hostname', 'ip', 'date',
  'echo', 'pg_isready', 'nginx', 'node', 'which', 'file', 'lsof', 'mount',
]);
const WRITE_PATTERNS = /[><`]|\brm\b|\bmv\b|\bcp\b|\bdd\b|\bkill\b|\bpkill\b|\bshutdown\b|\breboot\b|\btruncate\b|\bfallocate\b|\bchmod\b|\bchown\b|\btee\b|\bsed\s+-i\b|\bapt\b|\bapt-get\b|systemctl\s+(start|stop|restart|reload|mask|unmask|enable|disable)\b|\bmkdir\b|\btouch\b|\buseradd\b|\bpasswd\b/;

function readOnlyViolation(command) {
  if (WRITE_PATTERNS.test(command)) return true;
  const first = command.trim().split(/\s+/)[0];
  return !READ_CMDS.has(first);
}

async function baoRead(secretPath) {
  const res = await fetch(`${config.bao.url}/v1/secret/data/${secretPath}`, {
    headers: { 'X-Vault-Token': config.bao.token },
  });
  if (!res.ok) throw new Error(`openbao read ${secretPath}: ${res.status}`);
  const json = await res.json();
  return json.data.data;
}

async function baoList(secretPath) {
  const res = await fetch(`${config.bao.url}/v1/secret/metadata/${secretPath}?list=true`, {
    headers: { 'X-Vault-Token': config.bao.token },
  });
  if (!res.ok) throw new Error(`openbao list ${secretPath}: ${res.status}`);
  const json = await res.json();
  return json.data.keys;
}

// Provider-neutral tool registry. Each entry is a zod shape plus a handler
// returning a plain string; buildOpsServer() wraps the set for the Claude
// Agent SDK, openaiToolSchemas()/runTool() expose the same set to the
// OpenAI-compatible loop. incident supplies postUpdate() and state {mode, ticketId}.
const defs = [
  {
    name: 'post_update',
    description: 'Post a short status update to the incident thread in Mattermost. Use this before and after each significant step so engineers can follow along.',
    shape: { message: z.string() },
    run: async (incident, { message }) => {
      await incident.postUpdate(message);
      return 'posted';
    },
  },

  {
    name: 'get_wiki_page',
    description: 'Fetch the raw wikitext of a documentation page. Useful pages: "Customer systems", "Cust1", "Maintenance calendar", "Process incident response".',
    shape: { title: z.string() },
    run: async (_incident, { title }) => {
      const t = encodeURIComponent(title.replace(/ /g, '_'));
      const res = await fetch(`${config.wiki.url}/index.php?title=${t}&action=raw`);
      if (!res.ok) return `page not found: ${title}`;
      return res.text();
    },
  },

  {
    name: 'vault_list',
    description: 'List entries under a path in OpenBao, e.g. "customers".',
    shape: { path: z.string() },
    run: async (_incident, { path: p }) => JSON.stringify(await baoList(p)),
  },

  {
    name: 'vault_read',
    description: 'Read a secret from OpenBao, e.g. "customers/cust1". Private key material is redacted; ssh_exec uses it automatically.',
    shape: { path: z.string() },
    run: async (_incident, { path: p }) => {
      const data = await baoRead(p);
      const safe = {};
      for (const [k, v] of Object.entries(data)) {
        safe[k] = /private_key|password|secret/i.test(k) ? '(redacted, used automatically)' : v;
      }
      return JSON.stringify(safe);
    },
  },

  {
    name: 'ssh_exec',
    description: 'Run a shell command on a customer host over ssh. Credentials are fetched from OpenBao (secret/customers/<name>). In read-only mode only diagnostic commands are allowed.',
    shape: { customer: z.string().describe('customer name, e.g. cust1'), command: z.string() },
    run: async (incident, { customer, command }) => {
      if (incident.state.mode === 'read-only' && readOnlyViolation(command)) {
        return `BLOCKED: incident is in read-only mode, command not on the diagnostic allowlist: ${command}`;
      }
      const creds = await baoRead(`customers/${customer}`);
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
    description: 'List open Zammad tickets, to spot known work in progress.',
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
    name: 'zammad_recent_tickets',
    description: 'List tickets updated within the last N hours (default 24), any state.',
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
      if (!incident.state.ticketId) return 'no ticket attached to this incident';
      await zammad.addNote(incident.state.ticketId, note);
      if (state) await zammad.setState(incident.state.ticketId, state);
      return 'ticket updated';
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

export function buildOpsServer(incident) {
  const tools = defs.map((d) =>
    tool(d.name, d.description, d.shape, async (args) => text(await d.run(incident, args)))
  );
  return createSdkMcpServer({ name: 'ops', version: '1.0.0', tools });
}

export const allowedToolNames = defs.map((d) => `mcp__ops__${d.name}`);

export function openaiToolSchemas() {
  return defs.map((d) => {
    const { $schema, ...parameters } = z.toJSONSchema(z.object(d.shape));
    return { type: 'function', function: { name: d.name, description: d.description, parameters } };
  });
}

export async function runTool(incident, name, args) {
  const d = defs.find((t) => t.name === name);
  if (!d) return `unknown tool: ${name}`;
  const parsed = z.object(d.shape).safeParse(args ?? {});
  if (!parsed.success) return `invalid arguments for ${name}: ${parsed.error.message}`;
  return d.run(incident, parsed.data);
}
