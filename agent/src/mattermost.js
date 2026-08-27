import WebSocket from 'ws';
import { config } from './config.js';

const { url, token } = config.mattermost;

async function api(path, method = 'GET', body) {
  const res = await fetch(`${url}/api/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`mattermost ${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

let channelId = null;
let botUserId = null;

export async function init() {
  const me = await api('/users/me');
  botUserId = me.id;
  const team = await api(`/teams/name/${config.mattermost.team}`);
  const channel = await api(`/teams/${team.id}/channels/name/${config.mattermost.channel}`);
  channelId = channel.id;
  return { botUserId, channelId };
}

export async function post(message, rootId) {
  return api('/posts', 'POST', {
    channel_id: channelId,
    message,
    root_id: rootId || '',
  });
}

// Every post in a thread, oldest first, with usernames resolved. Used when an
// engineer mentions the agent in a thread the harness has no session for.
export async function thread(rootId, limit = 40) {
  const data = await api(`/posts/${rootId}/thread?perPage=200`);
  const posts = Object.values(data.posts || {})
    .filter((p) => p.delete_at === 0)
    .sort((a, b) => a.create_at - b.create_at)
    .slice(-limit);
  const out = [];
  for (const p of posts) {
    out.push({
      at: new Date(p.create_at).toISOString(),
      author: p.user_id === botUserId ? 'agent (you)' : await userName(p.user_id),
      message: (p.message || '').slice(0, 1500),
      is_root: p.id === rootId,
    });
  }
  return out;
}

export function isSelf(userId) {
  return userId === botUserId;
}

export async function userName(userId) {
  try {
    const u = await api(`/users/${userId}`);
    return u.username;
  } catch {
    return 'someone';
  }
}

// Listen for replies in the incidents channel. onPost(post) is called for
// every message not authored by the bot.
export function listen(onPost) {
  const wsUrl = url.replace(/^http/, 'ws') + '/api/v4/websocket';
  let ws;

  const connect = () => {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }));
    });
    ws.on('message', (raw) => {
      let ev;
      try { ev = JSON.parse(raw); } catch { return; }
      if (ev.event !== 'posted') return;
      let p;
      try { p = JSON.parse(ev.data.post); } catch { return; }
      if (p.channel_id !== channelId || isSelf(p.user_id)) return;
      onPost(p).catch((err) => console.error('onPost error', err));
    });
    ws.on('close', () => setTimeout(connect, 3000));
    ws.on('error', (err) => console.error('mattermost ws error', err.message));
  };
  connect();
}
