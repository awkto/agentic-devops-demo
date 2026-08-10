import express from 'express';
import { config } from './config.js';
import * as mm from './mattermost.js';
import { Incident } from './incident.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// key -> Incident
const incidents = new Map();
// mattermost root post id -> Incident
const byRoot = new Map();

function auth(req, res, next) {
  if (req.get('X-Webhook-Token') === config.webhookSecret) return next();
  // Zammad webhooks authenticate with basic auth instead of a custom header
  const basic = (req.get('Authorization') || '').match(/^Basic (.+)$/);
  if (basic) {
    const pass = Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':');
    if (pass === config.webhookSecret) return next();
  }
  return res.status(401).json({ error: 'bad token' });
}

function launch(key, trigger) {
  const existing = incidents.get(key);
  if (existing && !existing.done) return existing;
  const inc = new Incident(key, trigger);
  incidents.set(key, inc);
  inc.run()
    .catch((err) => console.error(`incident ${key} run failed`, err))
    .finally(() => {
      if (inc.rootId) byRoot.delete(inc.rootId);
    });
  // rootId becomes available once the first post lands
  const track = setInterval(() => {
    if (inc.rootId) {
      byRoot.set(inc.rootId, inc);
      clearInterval(track);
    }
    if (inc.done) clearInterval(track);
  }, 500);
  return inc;
}

app.post('/webhook/icinga', auth, (req, res) => {
  const b = req.body || {};
  const key = `icinga:${b.host}:${b.service}`;
  console.log(`icinga webhook: ${key} type=${b.type} state=${b.state}`);
  if (b.type === 'RECOVERY') {
    const inc = incidents.get(key);
    if (inc && !inc.done) {
      inc.enqueue(`[Icinga] Recovery notification: ${b.host}/${b.service} is ${b.state}. Output: ${b.output}`);
    }
    return res.json({ ok: true, action: 'recovery-forwarded' });
  }
  const existing = incidents.get(key);
  if (existing && !existing.done) {
    return res.json({ ok: true, action: 'already-active' });
  }
  launch(key, { source: 'icinga', ...b });
  res.json({ ok: true, action: 'incident-started' });
});

app.post('/webhook/zammad', auth, (req, res) => {
  const t = req.body?.ticket;
  if (!t || !t.id) return res.status(400).json({ error: 'no ticket in payload' });
  console.log(`zammad webhook: ticket ${t.number} "${t.title}"`);
  // ignore tickets the agent itself files for icinga alerts
  if ((t.title || '').startsWith('[icinga]')) {
    return res.json({ ok: true, action: 'ignored-own-ticket' });
  }
  const key = `zammad:${t.id}`;
  if (incidents.get(key) && !incidents.get(key).done) {
    return res.json({ ok: true, action: 'already-active' });
  }
  launch(key, {
    source: 'zammad',
    ticketId: t.id,
    ticketNumber: t.number,
    title: t.title,
    body: req.body?.article?.body || '',
    customer: t.customer_id,
  });
  res.json({ ok: true, action: 'incident-started' });
});

app.get('/', (_req, res) => {
  const lines = ['agent harness', ''];
  for (const [key, inc] of incidents) {
    lines.push(`${key}  mode=${inc.state.mode}  ${inc.done ? 'done' : 'active'}`);
  }
  res.type('text/plain').send(lines.join('\n'));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const main = async () => {
  await mm.init();
  mm.listen(async (post) => {
    if (!post.root_id) return;
    const inc = byRoot.get(post.root_id);
    if (!inc || inc.done) return;
    const username = await mm.userName(post.user_id);
    await inc.handleThreadReply(post.message, username);
  });
  app.listen(config.port, () => {
    console.log(`agent harness listening on :${config.port}`);
  });
};

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
