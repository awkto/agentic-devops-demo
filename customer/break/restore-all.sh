#!/bin/bash
# Undo every cust1 scenario, whichever way it was fixed. Database-side resets
# live in customer/db/break/restore-db.sh on db1.
set -x
# port squatter
pkill -f "http.server 80" || true
# masked unit
systemctl unmask nginx || true
# firewall
while iptables -C INPUT -p tcp --dport 80 -j DROP 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 80 -j DROP
done
# web root content and permissions
[ -f /root/index.html.parked ] && mv -f /root/index.html.parked /var/www/html/index.html
[ -s /var/www/html/index.html ] || cp /opt/demo/customer/site/index.html /var/www/html/index.html
chmod 644 /var/www/html/index.html
# app config: password back, host preserved
[ -f /root/config.json.old ] && mv /root/config.json.old /opt/app/config.json
sed -i 's/"password": "[^"]*"/"password": "app"/' /opt/app/config.json
# disk
rm -rf /var/log/app-debug
# nginx config faults
[ -f /root/nginx.conf.parked ] && mv -f /root/nginx.conf.parked /etc/nginx/nginx.conf
[ -f /root/default.parked ] && mv -f /root/default.parked /etc/nginx/sites-available/default
systemctl start nginx || true
systemctl restart nodeapp
