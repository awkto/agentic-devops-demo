import express from 'express';
import fs from 'fs';
import { config } from './config.js';
import * as mattermost from './mattermost.js';
import { Incident } from './incident.js';
import * as alerts from './alerts.js';
import { adminRouter } from './admin.js';
import * as settings from './settings.js';
import * as audit from './audit.js';

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
    profile: inc.profile,
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

// Kill switch: triggers for a disabled agent are dropped but still audited.
function ignoredWhileDisabled(summary, rootId, actor, profile) {
  audit.record({ profile, kind: 'trigger', rootId, actor, summary: `${summary} (ignored: disabled)`, detail: { note: 'ignored: disabled' } });
}

// profile name -> Mattermost client (own bot token, own websocket)
const clients = new Map();

function launch(key, trigger, opts) {
  const existing = incidents.get(key);
  if (existing && !existing.done) return existing;
  const inc = new Incident(key, trigger, { ...opts, mm: clients.get(opts.profile), onSession: rememberSession });
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

// Alerts and tickets go to the enabled profile that takes alerts.
function alertProfile(summary, actor) {
  const p = settings.alertProfile();
  if (p) return p;
  const off = settings.anyAlertProfile();
  if (off) ignoredWhileDisabled(summary, null, actor, off.name);
  return null;
}

app.post('/webhook/icinga', auth, (req, res) => {
  const b = req.body || {};
  const key = `icinga:${b.host}:${b.service}`;
  console.log(`icinga webhook: ${key} type=${b.type} state=${b.state}`);
  alerts.record(b);
  const prof = alertProfile(`icinga ${b.type || ''} ${b.host}/${b.service} ${b.state}`, 'icinga');
  if (!prof) return res.json({ ok: true, action: 'ignored-no-agent' });
  if (b.type === 'RECOVERY') {
    const inc = incidents.get(key);
    if (inc && !inc.done) {
      inc.auditTrigger({ source: 'icinga', ...b });
      inc.enqueue(`[Icinga] Recovery notification: ${b.host}/${b.service} is ${b.state}. Output: ${b.output}`);
    }
    return res.json({ ok: true, action: 'recovery-forwarded' });
  }
  const existing = incidents.get(key);
  if (existing && !existing.done) {
    // The service broke again while the previous session is still open (idle
    // window). Forward into the thread instead of dropping the alert.
    existing.auditTrigger({ source: 'icinga', ...b });
    existing.enqueue(`[Icinga] New problem notification: ${b.host}/${b.service} is ${b.state} again. Output: ${b.output}. Investigate.`);
    existing.resetIdleTimer();
    return res.json({ ok: true, action: 'problem-forwarded' });
  }
  launch(key, { source: 'icinga', ...b }, { profile: prof.name, channel: prof.channels[0] });
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
  const prof = alertProfile(`zammad ticket #${t.number}: ${t.title}`, 'zammad');
  if (!prof) return res.json({ ok: true, action: 'ignored-no-agent' });
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
  }, { profile: prof.name, channel: prof.channels[0] });
  res.json({ ok: true, action: 'incident-started' });
});

app.get('/', (_req, res) => {
  const lines = ['agent harness', ''];
  for (const [key, inc] of incidents) {
    lines.push(`${key}  mode=${inc.state.mode}  ${inc.done ? 'done' : 'active'}`);
  }
  res.type('text/plain').send(lines.join('\n'));
});

app.use('/admin', adminRouter({
  onDisable: async (profile, admin) => {
    for (const inc of incidents.values()) if (!inc.done && inc.profile === profile) await inc.disabledBy(admin);
  },
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One listener per profile. Each reacts only to its own bot's name, in its
// allowed channels, from its allowed users, and only in threads it owns.
function handler(name, mm) {
  const mention = new RegExp(`@${escapeRe(settings.profile(name).bot)}(?![\\w.-])`, 'i');
  return async (post) => {
    const cfg = settings.profile(name);
    if (!cfg) return;
    const username = await mm.userName(post.user_id);
    const mentioned = mention.test(post.message);
    const root = post.root_id;
    const inc = root && byRoot.get(root);
    const past = root && finished[root];
    const owner = inc ? inc.profile : past ? (past.profile || 'ops') : null;
    const owned = owner === name;
    if (!mentioned && !owned) return;
    const thread = root || post.id;

    if (!settings.isEnabled(name)) {
      ignoredWhileDisabled(`message from ${username}: ${audit.clip(post.message, 120)}`, thread, username, name);
      return;
    }

    const refuse = async (why, text) => {
      audit.record({ profile: name, kind: 'refusal', rootId: thread, actor: username, summary: `${why}: ${audit.clip(post.message, 100)}`, detail: { reason: why, message: audit.clip(post.message) } });
      await mm.post(text, thread).catch((err) => console.error('refusal post failed', err.message));
    };
    const chan = await mm.channelName(post.channel_id);
    if (!cfg.channels.includes(chan)) {
      return refuse('channel not allowed', `I don't answer in ~${chan}. Ask in ${cfg.channels.map((c) => `~${c}`).join(' or ')}.`);
    }
    if (cfg.users.length && !cfg.users.includes(username)) {
      return refuse('user not allowed', `Sorry @${username}, you are not on my allowed users list.`);
    }

    if (owned) {
      if (inc && !inc.done) {
        await inc.handleThreadReply(post.message, username);
        return;
      }
      if (past) {
        console.log(`${name}: followup in thread ${root} from ${username}`);
        launch(`followup:${root}`, { source: 'followup', username, message: post.message }, {
          profile: name, rootId: root, resume: past.sessionId, mode: past.mode, ticketId: past.ticketId,
        });
        return;
      }
    }
    if (!mentioned) return;
    // Top-level mention, or a mention in a thread this profile has no session
    // for (a restart, an engineer's own thread, another agent's thread): read
    // the thread from Mattermost so the reply has its context.
    console.log(`${name}: mention from ${username}: ${post.message.slice(0, 80)}`);
    let transcript;
    if (root) {
      transcript = await mm.thread(root).catch((err) => {
        console.error('thread read failed', err.message);
        return null;
      });
    }
    launch(`mention:${post.id}`, { source: 'mention', username, message: post.message, transcript },
      { profile: name, rootId: thread });
  };
}

const main = async () => {
  for (const p of settings.profiles()) {
    const token = process.env[p.token_env];
    if (!token) { console.error(`profile ${p.name}: ${p.token_env} not set, profile not started`); continue; }
    const mm = mattermost.createClient(p.name, token);
    await mm.init();
    if (mm.botName !== p.bot) console.error(`profile ${p.name}: token belongs to ${mm.botName}, expected ${p.bot}`);
    clients.set(p.name, mm);
    mm.listen(handler(p.name, mm));
  }
  app.listen(config.port, () => {
    console.log(`agent harness listening on :${config.port}`);
  });
};

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
