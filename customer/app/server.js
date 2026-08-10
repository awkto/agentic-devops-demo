const http = require('http');
const fs = require('fs');
const { Client } = require('pg');

const config = JSON.parse(fs.readFileSync('/opt/app/config.json', 'utf8'));

async function dbTime() {
  const client = new Client(config.db);
  await client.connect();
  const res = await client.query('SELECT now() AS now');
  await client.end();
  return res.rows[0].now;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  try {
    const now = await dbTime();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>Northwind status dashboard</h1><p>Database time: ${now}</p>`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`database error: ${err.message}\n`);
  }
});

server.listen(config.port, () => {
  console.log(`nodeapp listening on ${config.port}`);
});
