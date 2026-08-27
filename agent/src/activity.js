// What the agent itself has done recently, across sessions. Each incident and
// mention runs in its own session with its own memory, so without this a new
// alert cannot tell that the outage it is looking at was one an engineer asked
// for minutes ago in another thread. Written to disk so it survives restarts.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const FILE = path.join(path.dirname(config.sessionsDir), 'activity.jsonl');
const MAX_LINES = 3000;

export function record({ kind, key, threadId, text }) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind,
    session: key || null,
    thread_id: threadId || null,
    text: (text || '').slice(0, 600),
  });
  try {
    fs.appendFileSync(FILE, line + '\n');
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(FILE, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch (err) {
    console.error('activity log write failed', err.message);
  }
}

export function recent({ hours = 4, limit = 60, excludeThread } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  let rows = [];
  try {
    rows = fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((r) => Date.parse(r.at) >= since)
      .filter((r) => !excludeThread || r.thread_id !== excludeThread);
  } catch {
    rows = [];
  }
  const threads = {};
  for (const r of rows) {
    if (!r.thread_id) continue;
    const t = (threads[r.thread_id] = threads[r.thread_id] || { session: r.session, started: r.at, entries: 0, last: null });
    t.entries++;
    t.last = r.at;
  }
  return {
    window_hours: hours,
    threads,
    entries: rows.slice(-limit),
    note: rows.length === 0 ? 'Nothing recorded in this window.' : undefined,
  };
}
