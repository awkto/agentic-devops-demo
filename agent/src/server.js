import express from 'express';
import fs from 'fs';
import { config } from './config.js';
import * as mm from './mattermost.js';
import { Incident } from './incident.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// key -> Incident
const incidents = new Map();
// mattermost root post id -> active Incident
const byRoot = new Map();

// rootId -> { sessionId, ticketId, mode } for finished sessions, so thread
// replies can resume them with full context. Survives harness restarts.
const STATE_FILE = process.env.STATE_FILE || '/opt/agent/state.json';
let finished = {};
try { finished = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function rememberSession(inc) {
  if (!inc.rootId || !inc.sessionId) return;
  finished[inc.rootId] = {
    sessionId: inc.sessionId,
    ticketId: inc.state.ticketId,
    mode: inc.state.mode,
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(finished)); } catch (err) {
    console.error('state save failed', err.message);
  }
}

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

function launch(key, trigger, opts) {
  const existing = incidents.get(key);
  if (existing && !existing.done) return existing;
  const inc = new Incident(key, trigger, opts);
  incidents.set(key, inc);
  inc.run()
    .catch((err) => console.error(`incident ${key} run failed`, err))
    .finally(() => {
      rememberSession(inc);
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

const MENTION = /@agent\b/i;

const main = async () => {
  await mm.init();
  mm.listen(async (post) => {
    const username = await mm.userName(post.user_id);

    if (post.root_id) {
      // reply in a thread: active incident gets it injected live
      const inc = byRoot.get(post.root_id);
      if (inc && !inc.done) {
        await inc.handleThreadReply(post.message, username);
        return;
      }
      // finished incident: resume the original session with full context
      const past = finished[post.root_id];
      if (past) {
        console.log(`followup in thread ${post.root_id} from ${username}`);
        launch(`followup:${post.root_id}`, {
          source: 'followup',
          username,
          message: post.message,
        }, {
          rootId: post.root_id,
          resume: past.sessionId,
          mode: past.mode,
          ticketId: past.ticketId,
        });
        return;
      }
      // unknown thread: only react if explicitly mentioned
      if (MENTION.test(post.message)) {
        launch(`mention:${post.id}`, {
          source: 'mention',
          username,
          message: post.message,
        }, { rootId: post.root_id });
      }
      return;
    }

    // top-level channel post mentioning the agent: ad-hoc Q&A in its thread
    if (MENTION.test(post.message)) {
      console.log(`mention from ${username}: ${post.message.slice(0, 80)}`);
      launch(`mention:${post.id}`, {
        source: 'mention',
        username,
        message: post.message,
      }, { rootId: post.id });
    }
  });
  app.listen(config.port, () => {
    console.log(`agent harness listening on :${config.port}`);
  });
};

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
