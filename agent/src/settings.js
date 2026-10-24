// Key/value settings the admin page edits, in the same SQLite file as the
// audit log (/opt/agent/admin.db). Survives agentd restarts and redeploys.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { config } from './config.js';

const FILE = process.env.ADMIN_DB || path.join(path.dirname(config.sessionsDir), 'admin.db');
const db = new DatabaseSync(FILE);
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

export function get(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function set(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// Kill switch, keyed by agent profile name, plus one global switch over all
// agents. Default on.
export const allEnabled = () => get('agents.all.enabled', true) !== false;
export const setAllEnabled = (on) => set('agents.all.enabled', !!on);
export const ownEnabled = (profile) => get(`agent.${profile}.enabled`, true) !== false;
export const isEnabled = (profile = 'ops') => allEnabled() && ownEnabled(profile);
export const setEnabled = (profile, on) => set(`agent.${profile}.enabled`, !!on);

// Agent profiles: separate bot identity, access and permissions per agent.
// Seeded once; after that the admin page owns them.
db.exec(`CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  bot TEXT NOT NULL,
  token_env TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read-write',
  takes_alerts INTEGER NOT NULL DEFAULT 0,
  allowed_users TEXT NOT NULL DEFAULT '',
  allowed_channels TEXT NOT NULL DEFAULT ''
)`);
const seed = db.prepare('INSERT OR IGNORE INTO profiles (name, display, bot, token_env, mode, takes_alerts, allowed_users, allowed_channels) VALUES (?,?,?,?,?,?,?,?)');
seed.run('ops', 'Ops agent', 'agent', 'MM_BOT_TOKEN', 'read-write', 1, '', 'incidents');
seed.run('ops-reader', 'Ops reader', 'agent-reader', 'MM_READER_BOT_TOKEN', 'read-only', 0, '', 'incidents,ops-questions');

const csv = (s) => String(s || '').split(',').map((x) => x.trim().replace(/^[@#]/, '')).filter(Boolean);
const shape = (r) => r && ({ ...r, takes_alerts: !!r.takes_alerts, users: csv(r.allowed_users), channels: csv(r.allowed_channels) });
export const profiles = () => db.prepare('SELECT * FROM profiles ORDER BY rowid').all().map(shape);
export const profile = (name) => shape(db.prepare('SELECT * FROM profiles WHERE name = ?').get(name));
export const alertProfile = () => profiles().find((p) => p.takes_alerts && isEnabled(p.name));
export const anyAlertProfile = () => profiles().find((p) => p.takes_alerts);

export const PROFILE_FIELDS = ['mode', 'takes_alerts', 'allowed_users', 'allowed_channels'];
export function updateProfile(name, f) {
  db.prepare('UPDATE profiles SET mode = ?, takes_alerts = ?, allowed_users = ?, allowed_channels = ? WHERE name = ?')
    .run(f.mode, f.takes_alerts ? 1 : 0, csv(f.allowed_users).join(','), csv(f.allowed_channels).join(','), name);
}

// Per-agent tool levels (none|read|write). Only overrides are stored; a tool
// without a row follows the default in tools.js. Read on every call, so a
// change applies to the next turn without a restart.
db.exec('CREATE TABLE IF NOT EXISTS profile_tools (profile TEXT NOT NULL, tool TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY (profile, tool))');
export const toolLevels = (profile) =>
  Object.fromEntries(db.prepare('SELECT tool, level FROM profile_tools WHERE profile = ?').all(profile).map((r) => [r.tool, r.level]));
// level null clears the override (back to the default).
export function setToolLevel(profile, tool, level) {
  if (level) {
    db.prepare('INSERT INTO profile_tools (profile, tool, level) VALUES (?,?,?) ON CONFLICT(profile, tool) DO UPDATE SET level = excluded.level').run(profile, tool, level);
  } else {
    db.prepare('DELETE FROM profile_tools WHERE profile = ? AND tool = ?').run(profile, tool);
  }
}
