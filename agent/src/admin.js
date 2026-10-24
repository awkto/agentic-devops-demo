import crypto from 'crypto';
import express from 'express';
import { config } from './config.js';

// /admin: Keycloak OIDC authorization-code login, signed session cookie.
// Roles come from the ID token "roles" claim. agent-admin may edit,
// agent-viewer is read-only (see requireAdmin).
const ROLES = ['agent-admin', 'agent-viewer'];
const COOKIE = 'agent_admin';
const SESSION_SECONDS = 8 * 3600;
const cfg = config.admin;
const key = crypto.createHash('sha256').update(`agent-admin-session:${cfg.clientSecret}`).digest();

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url');

function sign(obj) {
  const body = b64(JSON.stringify(obj));
  return `${body}.${mac(body)}`;
}

function verify(value) {
  const [body, sig] = (value || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    return obj.exp > Date.now() / 1000 ? obj : null;
  } catch { return null; }
}

function cookies(req) {
  const out = {};
  for (const part of (req.get('Cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  res.append('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
section{border:1px solid #ccc;border-radius:4px;padding:.5rem 1rem;margin:1rem 0}
.muted{color:#666}</style></head><body>${body}</body></html>`;
}

// Attaches req.admin = { user, name, roles, role } when logged in with a valid role.
function session(req, _res, next) {
  const s = verify(cookies(req)[COOKIE]);
  if (s && s.t === 'session') {
    req.admin = { user: s.user, name: s.name, roles: s.roles, role: s.roles.includes('agent-admin') ? 'agent-admin' : 'agent-viewer' };
  }
  next();
}

// For routes that read: any logged-in role. Browsers are sent to login.
export function requireViewer(req, res, next) {
  if (req.admin) return next();
  return res.redirect('/admin/login');
}

// For future write routes: agent-admin only, viewers get 403.
export function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: 'login required' });
  if (req.admin.role !== 'agent-admin') return res.status(403).json({ error: 'agent-admin role required' });
  next();
}

async function tokenExchange(code) {
  const r = await fetch(`${cfg.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`token endpoint ${r.status}`);
  return r.json();
}

export function adminRouter() {
  const router = express.Router();

  if (!cfg.clientSecret) {
    router.use((_req, res) => res.status(503).type('text/plain').send('admin not configured (AGENT_ADMIN_CLIENT_SECRET)'));
    return router;
  }

  router.use(session);

  router.get('/login', (_req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    setCookie(res, `${COOKIE}_login`, sign({ t: 'login', state, nonce, exp: Date.now() / 1000 + 600 }), 600);
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state,
      nonce,
    });
    res.redirect(`${cfg.issuer}/protocol/openid-connect/auth?${q}`);
  });

  router.get('/callback', async (req, res) => {
    const login = verify(cookies(req)[`${COOKIE}_login`]);
    if (!login || login.t !== 'login' || !req.query.code || req.query.state !== login.state) {
      return res.status(400).type('text/plain').send('login failed: bad or expired state, try /admin again');
    }
    try {
      const tok = await tokenExchange(String(req.query.code));
      // The ID token came straight from the token endpoint over TLS, so the
      // claims are trusted without checking the signature (OIDC core 3.1.3.7).
      const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
      if (claims.iss !== cfg.issuer || claims.nonce !== login.nonce
        || ![].concat(claims.aud).includes(cfg.clientId)) {
        throw new Error('id token claims mismatch');
      }
      const roles = (claims.roles || []).filter((r) => ROLES.includes(r));
      if (!roles.length) {
        return res.status(403).type('text/plain').send(`${claims.preferred_username} has no agent-admin or agent-viewer role`);
      }
      setCookie(res, `${COOKIE}_login`, '', 0);
      setCookie(res, COOKIE, sign({
        t: 'session',
        user: claims.preferred_username,
        name: claims.name || claims.preferred_username,
        roles,
        exp: Date.now() / 1000 + SESSION_SECONDS,
      }), SESSION_SECONDS);
      res.redirect('/admin');
    } catch (err) {
      console.error('admin login failed', err.message);
      res.status(502).type('text/plain').send('login failed');
    }
  });

  router.get('/logout', (_req, res) => {
    setCookie(res, COOKIE, '', 0);
    res.redirect('/admin');
  });

  router.get('/', requireViewer, (req, res) => {
    const a = req.admin;
    res.send(page('Agent admin', `<h1>Agent admin</h1>
<p>Logged in as <b id="user">${esc(a.user)}</b> (${esc(a.name)}), role <b id="role">${esc(a.role)}</b>
${a.role === 'agent-admin' ? '' : '<span class="muted">(read-only)</span>'}
 &middot; <a href="/admin/logout">log out</a></p>
<section><h2>Agents</h2><p class="muted">Not built yet.</p></section>
<section><h2>Audit</h2><p class="muted">Not built yet.</p></section>`));
  });

  return router;
}
