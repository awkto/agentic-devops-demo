// Append-only audit log in SQLite (/opt/agent/admin.db, next to sessions).
// One row per event, written synchronously the moment it happens, so a crash
// or restart mid-incident loses nothing. Never throws into the caller.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { config } from './config.js';

const FILE = process.env.ADMIN_DB || path.join(path.dirname(config.sessionsDir), 'admin.db');
export const KINDS = ['alert', 'trigger', 'model_call', 'tool_call', 'post', 'ticket', 'admin_change', 'refusal'];

const db = new DatabaseSync(FILE);
db.exec(`CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  profile TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_id TEXT,
  ticket_id TEXT,
  actor TEXT,
  summary TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS audit_root ON audit(root_id);`);
const insert = db.prepare(
  'INSERT INTO audit (ts, profile, kind, root_id, ticket_id, actor, summary, detail) VALUES (?,?,?,?,?,?,?,?)');

export const clip = (s, n = 2000) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null);
  return t.length > n ? `${t.slice(0, n)}... [${t.length} chars]` : t;
};

export function record({ profile = 'ops', kind, rootId, ticketId, actor, summary, detail }) {
  try {
    insert.run(new Date().toISOString(), profile, kind, rootId ? String(rootId) : null,
      ticketId ? String(ticketId) : null, actor || null, String(summary || '').slice(0, 300),
      detail === undefined ? null : JSON.stringify(detail));
  } catch (err) {
    console.error('audit write failed', err.message);
  }
}

// filters: kind, root, from, to (ISO or anything Date.parse takes), limit
export function query({ kind, root, from, to, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (root) { where.push('root_id = ?'); args.push(root); }
  const f = from && Date.parse(from);
  const t = to && Date.parse(to);
  if (f) { where.push('ts >= ?'); args.push(new Date(f).toISOString()); }
  if (t) { where.push('ts <= ?'); args.push(new Date(t).toISOString()); }
  const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(limit) || 500, 50000)}`;
  return db.prepare(sql).all(...args);
}

// Rows of the given kinds since a time, oldest first. Feeds the agent's own
// alert history and recent-activity tools. The demo reset sets history.since
// so earlier takes stay in the audit but out of the agent's view.
export function since(kinds, fromMs) {
  const floor = Math.max(fromMs, Date.parse(historySince()) || 0);
  return db.prepare(`SELECT * FROM audit WHERE kind IN (${kinds.map(() => '?').join(',')}) AND ts >= ? ORDER BY id`)
    .all(...kinds, new Date(floor).toISOString())
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

function historySince() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'history.since'").get();
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}
