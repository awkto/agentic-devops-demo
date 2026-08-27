// Alert log. Icinga notifies the harness of every state change it fires on;
// this records them so the agent can answer "has this happened before?" without
// a monitoring database. The file survives harness restarts, and is trimmed
// once it grows past MAX_LINES.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const FILE = path.join(path.dirname(config.sessionsDir), 'alerts.jsonl');
const MAX_LINES = 5000;

export function record(event) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    host: event.host || null,
    service: event.service || null,
    type: event.type || null,
    state: event.state || null,
    output: (event.output || '').slice(0, 200),
  });
  try {
    fs.appendFileSync(FILE, line + '\n');
  } catch (err) {
    console.error('alert log write failed', err.message);
  }
  trim();
}

function trim() {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(FILE, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch {}
}

function read() {
  try {
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Alerts in the window, newest first, plus a per-service summary: how often it
// fired, when it last broke and last recovered, and how long each outage ran.
export function history({ service, hours = 24, limit = 50 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  const all = read().filter((e) => Date.parse(e.at) >= since);
  const match = service
    ? all.filter((e) => `${e.host}/${e.service}`.toLowerCase().includes(service.toLowerCase()))
    : all;

  const summary = {};
  for (const e of match) {
    const key = `${e.host}/${e.service}`;
    const s = (summary[key] = summary[key] || {
      problems: 0, recoveries: 0, last_problem: null, last_recovery: null, outages_seconds: [],
    });
    if (e.type === 'PROBLEM') { s.problems++; s.last_problem = e.at; }
    if (e.type === 'RECOVERY') {
      s.recoveries++;
      s.last_recovery = e.at;
      if (s.last_problem) {
        s.outages_seconds.push(Math.round((Date.parse(e.at) - Date.parse(s.last_problem)) / 1000));
      }
    }
  }

  return {
    window_hours: hours,
    alerts_in_window: match.length,
    summary,
    events: match.slice(-limit).reverse(),
    note: match.length === 0
      ? 'No alerts recorded in this window. The log starts when the harness was first deployed.'
      : undefined,
  };
}
