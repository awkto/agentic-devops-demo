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

const text = (s) => ({ content: [{ type: 'text', text: s }] });

// incident supplies: postUpdate(message), state {mode, ticketId}
export function buildOpsServer(incident) {
  const tools = [
    tool(
      'post_update',
      'Post a short status update to the incident thread in Mattermost. Use this before and after each significant step so engineers can follow along.',
      { message: z.string() },
      async ({ message }) => {
        await incident.postUpdate(message);
        return text('posted');
      }
    ),

    tool(
      'get_wiki_page',
      'Fetch the raw wikitext of a documentation page. Useful pages: "Customer systems", "Cust1", "Maintenance calendar", "Process incident response".',
      { title: z.string() },
      async ({ title }) => {
        const t = encodeURIComponent(title.replace(/ /g, '_'));
        const res = await fetch(`${config.wiki.url}/index.php?title=${t}&action=raw`);
        if (!res.ok) return text(`page not found: ${title}`);
        return text(await res.text());
      }
    ),

    tool(
      'vault_list',
      'List entries under a path in OpenBao, e.g. "customers".',
      { path: z.string() },
      async ({ path: p }) => text(JSON.stringify(await baoList(p)))
    ),

    tool(
      'vault_read',
      'Read a secret from OpenBao, e.g. "customers/cust1". Private key material is redacted; ssh_exec uses it automatically.',
      { path: z.string() },
      async ({ path: p }) => {
        const data = await baoRead(p);
        const safe = {};
        for (const [k, v] of Object.entries(data)) {
          safe[k] = /private_key|password|secret/i.test(k) ? '(redacted, used automatically)' : v;
        }
        return text(JSON.stringify(safe));
      }
    ),

    tool(
      'ssh_exec',
      'Run a shell command on a customer host over ssh. Credentials are fetched from OpenBao (secret/customers/<name>). In read-only mode only diagnostic commands are allowed.',
      { customer: z.string().describe('customer name, e.g. cust1'), command: z.string() },
      async ({ customer, command }) => {
        if (incident.state.mode === 'read-only' && readOnlyViolation(command)) {
          return text(`BLOCKED: incident is in read-only mode, command not on the diagnostic allowlist: ${command}`);
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
          return text(out.slice(0, 20000) || '(no output)');
        } catch (err) {
          const out = [err.stdout, err.stderr, `exit: ${err.code ?? 'timeout'}`].filter(Boolean).join('\n');
          return text(out.slice(0, 20000));
        } finally {
          fs.rmSync(keyDir, { recursive: true, force: true });
        }
      }
    ),

    tool(
      'list_open_tickets',
      'List open Zammad tickets, to spot known work in progress.',
      {},
      async () => text(JSON.stringify(await zammad.listOpen()))
    ),

    tool(
      'icinga_status',
      'Current state of all monitored services: state, acknowledged, in_downtime, since, last output.',
      {},
      async () => text(JSON.stringify(await icinga.serviceStatus()))
    ),

    tool(
      'zammad_recent_tickets',
      'List tickets updated within the last N hours (default 24), any state.',
      { hours: z.number().optional() },
      async ({ hours }) => text(JSON.stringify(await zammad.listRecent(hours ?? 24)))
    ),

    tool(
      'zammad_ticket_articles',
      'Full note history of a ticket by id: who wrote what and when. Use to summarize how an incident was resolved.',
      { ticket_id: z.number() },
      async ({ ticket_id }) => text(JSON.stringify(await zammad.getArticles(ticket_id)))
    ),

    tool(
      'update_ticket',
      'Add a note to the incident Zammad ticket, optionally changing its state (open, closed).',
      { note: z.string(), state: z.enum(['open', 'closed']).optional() },
      async ({ note, state }) => {
        if (!incident.state.ticketId) return text('no ticket attached to this incident');
        await zammad.addNote(incident.state.ticketId, note);
        if (state) await zammad.setState(incident.state.ticketId, state);
        return text('ticket updated');
      }
    ),
  ];

  return createSdkMcpServer({ name: 'ops', version: '1.0.0', tools });
}

export const allowedToolNames = [
  'mcp__ops__post_update',
  'mcp__ops__get_wiki_page',
  'mcp__ops__vault_list',
  'mcp__ops__vault_read',
  'mcp__ops__ssh_exec',
  'mcp__ops__list_open_tickets',
  'mcp__ops__icinga_status',
  'mcp__ops__zammad_recent_tickets',
  'mcp__ops__zammad_ticket_articles',
  'mcp__ops__update_ticket',
];
