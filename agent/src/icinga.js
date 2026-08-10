import { config } from './config.js';

const { url, user, password } = config.icinga;

async function api(path) {
  if (!url) throw new Error('icinga api not configured');
  const res = await fetch(`${url}/v1${path}`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64'),
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`icinga GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function serviceStatus() {
  const json = await api(
    '/objects/services?attrs=display_name&attrs=state&attrs=acknowledgement&attrs=downtime_depth&attrs=last_state_change&attrs=last_check_result'
  );
  const stateNames = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'];
  return json.results.map((r) => ({
    service: r.name,
    state: stateNames[r.attrs.state] ?? r.attrs.state,
    acknowledged: r.attrs.acknowledgement > 0,
    in_downtime: r.attrs.downtime_depth > 0,
    since: new Date(r.attrs.last_state_change * 1000).toISOString(),
    output: (r.attrs.last_check_result?.output || '').slice(0, 150),
  }));
}
