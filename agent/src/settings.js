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

// Kill switch, keyed by agent profile name. Default on.
export const isEnabled = (profile = 'ops') => get(`agent.${profile}.enabled`, true) !== false;
export const setEnabled = (profile, on) => set(`agent.${profile}.enabled`, !!on);
export const PROFILES = ['ops'];
