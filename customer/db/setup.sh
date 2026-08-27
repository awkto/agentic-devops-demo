#!/bin/bash
# Run on the db1 droplet as root. Expects /opt/demo to be a checkout of this
# repo. Env: CUST1_IP (pg_hba allow for the app), AGENT_PUB (agent public key,
# authorized for dbops and, as the ungranted emergency path, for root).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql monitoring-plugins-basic acl

# --- postgres, listening for the app on cust1 -------------------------------
systemctl enable --now postgresql
PGCONF_DIR=$(ls -d /etc/postgresql/*/main | head -1)
mkdir -p "$PGCONF_DIR/conf.d"
echo "listen_addresses = '*'" > "$PGCONF_DIR/conf.d/listen.conf"
if [ -n "${CUST1_IP:-}" ]; then
  grep -q "host app app ${CUST1_IP}/32" "$PGCONF_DIR/pg_hba.conf" || \
    echo "host app app ${CUST1_IP}/32 scram-sha-256" >> "$PGCONF_DIR/pg_hba.conf"
fi
systemctl restart postgresql

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE app LOGIN PASSWORD 'app'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='app'" | grep -q 1 || \
  sudo -u postgres createdb -O app app

# positions of record, served by the account service on cust1
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

# --- dbops: the account the agent holds. Deliberately powerless. ------------
# No sudo, not in the postgres group. adm for /var/log, an ACL for reading the
# postgres config. The harness blocks write commands for this system too, but
# this account is what makes the read-only claim true.
id dbops >/dev/null 2>&1 || useradd -m -s /bin/bash dbops
usermod -aG adm dbops
mkdir -p /home/dbops/.ssh
if [ -n "${AGENT_PUB:-}" ]; then
  echo "$AGENT_PUB" > /home/dbops/.ssh/authorized_keys
fi
chmod 700 /home/dbops/.ssh
chmod 600 /home/dbops/.ssh/authorized_keys 2>/dev/null || true
chown -R dbops:dbops /home/dbops
setfacl -R -m u:dbops:rX /etc/postgresql

# emergency path: the same agent key opens root, but the vault secret holding
# root access (customers/cust1-db-admin) is NOT granted to the agent role.
# An engineer grants it mid-incident with scripts/grant-access.sh.
if [ -n "${AGENT_PUB:-}" ]; then
  mkdir -p /root/.ssh
  grep -qxF "$AGENT_PUB" /root/.ssh/authorized_keys 2>/dev/null || \
    echo "$AGENT_PUB" >> /root/.ssh/authorized_keys
fi

# assert the boundary: dbops must NOT be able to sudo
if runuser -u dbops -- sudo -n true 2>/dev/null; then
  echo "FATAL: dbops can sudo - the read-only boundary is broken" >&2
  exit 1
fi

# remote check helper used by Icinga via ssh as dbops
mkdir -p /opt/checks
cp /opt/demo/customer/db/check_postgres.sh /opt/checks/check_postgres.sh
chmod 755 /opt/checks/check_postgres.sh

# fault injection scripts (operator runs these as root)
mkdir -p /opt/break
cp /opt/demo/customer/db/break/*.sh /opt/break/
chmod +x /opt/break/*.sh

echo "database host ready (dbops boundary asserted)"
