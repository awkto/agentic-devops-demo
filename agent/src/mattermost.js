import WebSocket from 'ws';
import { config } from './config.js';
import * as audit from './audit.js';

const { url } = config.mattermost;

// Permalink to a post; for a thread root it opens the whole thread.
export const threadUrl = (postId) => `${url}/${config.mattermost.team}/pl/${postId}`;

// One client per agent profile: its own bot token, identity and websocket.
export function createClient(profile, token) {
  const team = config.mattermost.team;
  let botUserId = null;
  const chanByName = new Map();   // name -> id
  const chanById = new Map();     // id -> name
  const rootChan = new Map();     // thread root post id -> channel id
  const users = new Map();        // user id -> username

  async function api(path, method = 'GET', body) {
    const res = await fetch(`${url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`mattermost ${method} ${path}: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async function channelByName(name) {
    if (!chanByName.has(name)) {
      const t = await api(`/teams/name/${team}`);
      const c = await api(`/teams/${t.id}/channels/name/${name}`);
      chanByName.set(name, c.id);
      chanById.set(c.id, name);
    }
    return chanByName.get(name);
  }

  async function channelName(id) {
    if (!chanById.has(id)) {
      const c = await api(`/channels/${id}`);
      chanById.set(id, c.name);
      chanByName.set(c.name, id);
    }
    return chanById.get(id);
  }

  async function userName(userId) {
    if (users.has(userId)) return users.get(userId);
    try {
      const u = await api(`/users/${userId}`);
      users.set(userId, u.username);
      return u.username;
    } catch {
      return 'someone';
    }
  }

  const c = {
    profile,
    botName: null,
    channelName,
    userName,
    isSelf: (userId) => userId === botUserId,

    async init() {
      const me = await api('/users/me');
      botUserId = me.id;
      c.botName = me.username;
      return me;
    },

    // Where a thread lives. Seeded by the listener, else asked from Mattermost.
    noteRoot(rootId, channelId) { rootChan.set(rootId, channelId); },
    async rootChannel(rootId) {
      if (!rootChan.has(rootId)) rootChan.set(rootId, (await api(`/posts/${rootId}`)).channel_id);
      return rootChan.get(rootId);
    },

    // rootId set: reply in that thread. Otherwise a new root in channelName.
    async post(message, rootId, channel) {
      const channel_id = rootId ? await c.rootChannel(rootId) : await channelByName(channel);
      const posted = await api('/posts', 'POST', { channel_id, message, root_id: rootId || '' });
      if (!rootId) rootChan.set(posted.id, channel_id);
      audit.record({ profile, kind: 'post', rootId: rootId || posted.id, actor: c.botName, summary: message, detail: { post_id: posted.id, message: audit.clip(message) } });
      return posted;
    },

    // Every post in a thread, oldest first, with usernames resolved. Used when an
    // engineer mentions the agent in a thread the harness has no session for.
    async thread(rootId, limit = 40) {
      const data = await api(`/posts/${rootId}/thread?perPage=200`);
      const posts = Object.values(data.posts || {})
        .filter((p) => p.delete_at === 0)
        .sort((a, b) => a.create_at - b.create_at)
        .slice(-limit);
      const out = [];
      for (const p of posts) {
        out.push({
          at: new Date(p.create_at).toISOString(),
          author: p.user_id === botUserId ? `${c.botName} (you)` : await userName(p.user_id),
          message: (p.message || '').slice(0, 1500),
          is_root: p.id === rootId,
        });
      }
      return out;
    },

    // Listen for posts in every channel this bot is a member of. onPost(post)
    // is called for each message not authored by the bot.
    listen(onPost) {
      const wsUrl = url.replace(/^http/, 'ws') + '/api/v4/websocket';
      const connect = () => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => {
          ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }));
        });
        ws.on('message', (raw) => {
          let ev;
          try { ev = JSON.parse(raw); } catch { return; }
          if (ev.event !== 'posted') return;
          let p;
          try { p = JSON.parse(ev.data.post); } catch { return; }
          if (c.isSelf(p.user_id)) return;
          rootChan.set(p.root_id || p.id, p.channel_id);
          onPost(p).catch((err) => console.error(`${profile} onPost error`, err));
        });
        ws.on('close', () => setTimeout(connect, 3000));
        ws.on('error', (err) => console.error(`${profile} mattermost ws error`, err.message));
      };
      connect();
    },
  };
  return c;
}
