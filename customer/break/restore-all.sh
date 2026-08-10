#!/bin/bash
# Undo every scenario.
set -x
systemctl start nginx || true
rm -rf /var/log/app-debug
[ -f /root/config.json.old ] && mv /root/config.json.old /opt/app/config.json
conf=$(ls /etc/postgresql/*/main/postgresql.conf | head -1)
sed -i '/^port = 5433/d' "$conf"
systemctl restart postgresql
systemctl restart nodeapp
