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

echo "customer host ready"
