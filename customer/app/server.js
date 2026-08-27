const http = require('http');
const fs = require('fs');
const { Client } = require('pg');

const config = JSON.parse(fs.readFileSync('/opt/app/config.json', 'utf8'));

async function query(sql) {
  const client = new Client(config.db);
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function positions() {
  const res = await query('SELECT symbol, quantity, avg_price, opened FROM positions ORDER BY symbol');
  return res.rows.map((r) => ({
    symbol: r.symbol,
    quantity: Number(r.quantity),
    avg_price: Number(r.avg_price),
    opened: r.opened,
  }));
}

function page(rows, now) {
  const body = rows
    .map(
      (p) => `<tr><td>${p.symbol}</td><td>${p.quantity}</td><td>${p.avg_price.toFixed(2)}</td>` +
        `<td>${new Date(p.opened).toISOString().slice(0, 10)}</td></tr>`
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kestrel Markets - Account service</title>
<style>
  body { background:#0a0e13; color:#d8e2ec; font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;
         margin:0; padding:32px; }
  h1 { font-size:15px; letter-spacing:.14em; text-transform:uppercase; margin:0 0 4px; }
  p.sub { color:#6d8096; margin:0 0 24px; }
  table { border-collapse:collapse; min-width:420px; }
  th,td { text-align:left; padding:7px 18px 7px 0; border-bottom:1px solid #1e2a37; }
  th { color:#6d8096; font-weight:600; font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
  td:nth-child(2), td:nth-child(3) { text-align:right; font-variant-numeric:tabular-nums; }
  footer { color:#6d8096; margin-top:24px; }
  a { color:#f0a94b; }
</style></head><body>
<h1>Account service</h1>
<p class="sub">Positions of record for the Kestrel Markets trading desk.</p>
<table>
  <tr><th>Symbol</th><th>Quantity</th><th>Avg price</th><th>Opened</th></tr>
  ${body}
</table>
<footer>Database time ${now}. JSON at <a href="/api/positions">/api/positions</a>, health at <a href="/health">/health</a>.<br>
Trading desk: <a href="http://${config.siteHost || 'localhost'}/">front end</a>.</footer>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  try {
    if (req.url === '/api/positions') {
      const rows = await positions();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ positions: rows }));
      return;
    }

    const [rows, now] = [await positions(), (await query('SELECT now() AS now')).rows[0].now];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(rows, now));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(`database error: ${err.message}\n`);
  }
});

server.listen(config.port, () => {
  console.log(`nodeapp listening on ${config.port}`);
});
