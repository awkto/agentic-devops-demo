// What the agents themselves have done recently, across sessions. Each
// incident and mention runs in its own session with its own memory, so without
// this a new alert cannot tell that the outage it is looking at was one an
// engineer asked for minutes ago in another thread. Read from the audit log:
// what started each thread (trigger) and what the agents posted (post).
import * as audit from './audit.js';

export function recent({ hours = 4, limit = 60, excludeThread } = {}) {
  const rows = audit.since(['trigger', 'post'], Date.now() - hours * 3600 * 1000)
    .filter((r) => r.root_id && r.root_id !== excludeThread && r.detail?.note !== 'ignored: disabled')
    .map((r) => ({
      at: r.ts,
      kind: r.kind === 'post' ? 'post' : 'started',
      agent: r.profile,
      thread_id: r.root_id,
      by: r.actor,
      text: audit.clip(r.detail?.message || r.summary || '', 600),
    }));
  const threads = {};
  for (const r of rows) {
    const t = (threads[r.thread_id] = threads[r.thread_id] || { agent: r.agent, started: r.at, entries: 0, last: null });
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
