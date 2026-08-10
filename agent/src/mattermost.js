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
