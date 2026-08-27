#!/bin/bash
# Run on the customer droplet as root. Expects /opt/demo to be a checkout of
# this repo. Env: DB_HOST (the database host, db1.<domain>; defaults to
# localhost for old single-host deploys), AGENT_PUB (agent public key for the
# restricted backup account).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx monitoring-plugins-basic nodejs npm jq

DB_HOST=${DB_HOST:-127.0.0.1}

# migration: the database used to run locally on this host. If it is moving
# to db1, take the local install out of the picture so diagnosis stays honest.
if [ "$DB_HOST" != "127.0.0.1" ] && dpkg -l postgresql 2>/dev/null | grep -q '^ii'; then
  echo "==> removing local postgres (database now lives on $DB_HOST)"
  systemctl disable --now postgresql 2>/dev/null || true
  apt-get remove -y -qq 'postgresql*' >/dev/null
  rm -f /opt/checks/check_postgres.sh
fi

# website
cp /opt/demo/customer/site/index.html /var/www/html/index.html
systemctl enable --now nginx

# application
mkdir -p /opt/app
cp /opt/demo/customer/app/server.js /opt/app/server.js
cp /opt/demo/customer/app/package.json /opt/app/package.json
jq --arg h "$DB_HOST" '.db.host = $h' /opt/demo/customer/app/config.json > /opt/app/config.json
(cd /opt/app && npm install --omit=dev --no-audit --no-fund >/dev/null)
cp /opt/demo/customer/app/nodeapp.service /etc/systemd/system/nodeapp.service
systemctl daemon-reload
systemctl enable nodeapp
systemctl restart nodeapp

# fault injection scripts
mkdir -p /opt/break
rm -f /opt/break/break-db.sh   # moved to db1 with the database
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

echo "customer host ready (db at $DB_HOST)"
