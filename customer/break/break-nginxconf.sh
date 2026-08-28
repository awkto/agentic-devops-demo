#!/bin/bash
# Scenario: nginx is stopped and will not come back with a plain restart.
# Two config faults, deliberately in different files so `nginx -t` only
# reveals the second one after the first is fixed:
#   1. an unknown directive in the http block of /etc/nginx/nginx.conf
#   2. a missing semicolon in the site config
set -e

[ -f /root/nginx.conf.parked ] || cp /etc/nginx/nginx.conf /root/nginx.conf.parked
[ -f /root/default.parked ] || cp /etc/nginx/sites-available/default /root/default.parked

# 1. typo'd directive - nginx.conf is parsed before the site include
grep -q client_max_body_sze /etc/nginx/nginx.conf ||
  sed -i '0,/^\tgzip on;/s//\tgzip on;\n\tclient_max_body_sze 8m;/' /etc/nginx/nginx.conf

# 2. unterminated root directive in the site
sed -i 's|^\troot /var/www/html;|\troot /var/www/html|' /etc/nginx/sites-available/default

systemctl stop nginx
echo "nginx stopped, nginx.conf and the site config both broken"
nginx -t || true
