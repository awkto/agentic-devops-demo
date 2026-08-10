import { config } from './config.js';

const { url, token } = config.zammad;

async function api(path, method = 'GET', body) {
  const res = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Token token=${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`zammad ${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function createTicket(title, body) {
  return api('/tickets', 'POST', {
    title,
    group: 'Users',
    customer: `admin@${config.domain}`,
    article: { subject: title, body, type: 'note', internal: false },
  });
}

export async function addNote(ticketId, body, internal = false) {
  return api('/ticket_articles', 'POST', {
    ticket_id: ticketId,
    body,
    type: 'note',
    internal,
  });
}

export async function setState(ticketId, state) {
  return api(`/tickets/${ticketId}`, 'PUT', { state });
}

export async function listOpen() {
  const tickets = await api('/tickets?expand=true&per_page=50');
  return tickets
    .filter((t) => ['new', 'open'].includes(t.state))
    .map((t) => ({ id: t.id, number: t.number, title: t.title, state: t.state, created_at: t.created_at }));
}

export async function listRecent(hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const tickets = await api('/tickets?expand=true&per_page=100');
  return tickets
    .filter((t) => new Date(t.updated_at).getTime() >= cutoff)
    .map((t) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      state: t.state,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));
}

export async function getArticles(ticketId) {
  const articles = await api(`/ticket_articles/by_ticket/${ticketId}`);
  return articles.map((a) => ({
    from: a.from,
    created_at: a.created_at,
    internal: a.internal,
    body: (a.body || '').replace(/<[^>]+>/g, ' ').slice(0, 1500),
  }));
}
