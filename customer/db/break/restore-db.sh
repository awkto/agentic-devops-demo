#!/bin/bash
# Undo every db1 scenario, whichever way it was (or wasn't) fixed.
set -x
conf=$(ls /etc/postgresql/*/main/postgresql.conf | head -1)
sed -i '/^port = 5433/d' "$conf"
sudo -u postgres psql -q -c "ALTER USER app PASSWORD 'app'" 2>/dev/null || true
systemctl unmask postgresql 2>/dev/null || true
systemctl start postgresql || systemctl restart postgresql
sleep 2
sudo -u postgres psql -q -c "ALTER USER app PASSWORD 'app'" || true
