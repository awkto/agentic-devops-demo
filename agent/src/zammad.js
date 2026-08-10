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
