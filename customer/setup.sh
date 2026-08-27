#!/bin/bash
# Run on the customer droplet as root. Expects /opt/demo to be a checkout of
# this repo.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx postgresql monitoring-plugins-basic nodejs npm

# website
cp /opt/demo/customer/site/index.html /var/www/html/index.html
systemctl enable --now nginx

# database
systemctl enable --now postgresql
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE app LOGIN PASSWORD 'app'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='app'" | grep -q 1 || \
  sudo -u postgres createdb -O app app

# positions of record, served by the account service on :3000
sudo -u postgres psql -q -d app <<'SQL'
CREATE TABLE IF NOT EXISTS positions (
  symbol    text PRIMARY KEY,
  quantity  integer NOT NULL,
  avg_price numeric(10,2) NOT NULL,
  opened    date NOT NULL
);
INSERT INTO positions (symbol, quantity, avg_price, opened) VALUES
  ('KSTR', 1450, 171.40, '2026-03-11'),
  ('ORBT', 3200,  58.05, '2026-05-02'),
  ('NVAX',  480, 298.60, '2026-01-27'),
  ('HLIO', 6100,  44.85, '2026-06-14'),
  ('QBIT',  260, 517.30, '2026-04-08'),
  ('MRDN', 9400,  27.90, '2025-11-19')
ON CONFLICT (symbol) DO NOTHING;
GRANT SELECT ON positions TO app;
SQL

# application
mkdir -p /opt/app
cp /opt/demo/customer/app/server.js /opt/app/server.js
cp /opt/demo/customer/app/package.json /opt/app/package.json
cp /opt/demo/customer/app/config.json /opt/app/config.json
(cd /opt/app && npm install --omit=dev --no-audit --no-fund >/dev/null)
cp /opt/demo/customer/app/nodeapp.service /etc/systemd/system/nodeapp.service
systemctl daemon-reload
systemctl enable --now nodeapp

# remote check helpers used by Icinga via ssh
mkdir -p /opt/checks
cp /opt/demo/customer/checks/check_postgres.sh /opt/checks/check_postgres.sh
chmod +x /opt/checks/check_postgres.sh

# fault injection scripts
mkdir -p /opt/break
cp /opt/demo/customer/break/*.sh /opt/break/
chmod +x /opt/break/*.sh

# backup account: the restricted system for the OpenBao access-grant demo.
# Reachable with the agent key (AGENT_PUB passed in by deploy.sh), but the
# agent's vault role is not granted the cust1-backups secret by default.
if [ -n "${AGENT_PUB:-}" ]; then
  id backup >/dev/null 2>&1 || useradd -m -s /bin/bash backup
  mkdir -p /home/backup/.ssh /home/backup/snapshots
  echo "$AGENT_PUB" > /home/backup/.ssh/authorized_keys
  chmod 700 /home/backup/.ssh
  chmod 600 /home/backup/.ssh/authorized_keys
  for d in 1 2 3; do
    f="/home/backup/snapshots/cust1-db-$(date -d "-$d day" +%Y%m%d).tar.gz"
    [ -f "$f" ] || head -c $((RANDOM + 20000)) /dev/urandom > "$f"
  done
  ls -l /home/backup/snapshots > /home/backup/snapshots/snapshots.log
  chown -R backup:backup /home/backup
fi

echo "customer host ready"
