// Alert log. Icinga notifies the harness of every state change it fires on;
// each one is an "alert" row in the audit log, so the agent can answer "has
// this happened before?" without a monitoring database.
import * as audit from './audit.js';

export function record(event, profile = 'icinga') {
  const e = {
    host: event.host || null,
    service: event.service || null,
    type: event.type || null,
    state: event.state || null,
    output: (event.output || '').slice(0, 200),
  };
  audit.record({ profile, kind: 'alert', actor: 'icinga', summary: `${e.type} ${e.host}/${e.service} ${e.state}`, detail: e });
}

// Alerts in the window, newest first, plus a per-service summary: how often it
// fired, when it last broke and last recovered, and how long each outage ran.
export function history({ service, hours = 24, limit = 50 } = {}) {
  const all = audit.since(['alert'], Date.now() - hours * 3600 * 1000)
    .map((r) => ({ at: r.ts, ...r.detail }));
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
