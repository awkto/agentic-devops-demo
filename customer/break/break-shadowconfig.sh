#!/bin/bash
# Scenario: nginx is running and its config is valid, but nothing listens on 80.
# Three layers, each hiding the next:
#   1. a systemd drop-in starts nginx with a "legacy" config that listens on
#      8080, so `systemctl status` says running and plain `nginx -t` passes
#   2. the drop-in is immutable (chattr +i), so rm fails even as root
#   3. a cron "failover watchdog" reinstalls the drop-in within a minute if
#      it disappears, so a fix that looks finished undoes itself
set -e

mkdir -p /etc/nginx/legacy/sites /usr/local/lib/nginx-failover
sed 's|include /etc/nginx/sites-enabled/\*;|include /etc/nginx/legacy/sites/*;|' \
  /etc/nginx/nginx.conf > /etc/nginx/legacy/nginx.conf
sed -e 's/listen 80 default_server;/listen 8080 default_server;/' \
    -e 's/listen \[::\]:80 default_server;/listen [::]:8080 default_server;/' \
  /etc/nginx/sites-available/default > /etc/nginx/legacy/sites/default

cat > /usr/local/lib/nginx-failover/10-failover.conf <<'UNIT'
# Pin nginx to the failover config during the edge migration.
[Service]
ExecStartPre=
ExecStartPre=/usr/sbin/nginx -t -q -c /etc/nginx/legacy/nginx.conf -g 'daemon on; master_process on;'
ExecStart=
ExecStart=/usr/sbin/nginx -c /etc/nginx/legacy/nginx.conf -g 'daemon on; master_process on;'
ExecReload=
ExecReload=/usr/sbin/nginx -c /etc/nginx/legacy/nginx.conf -g 'daemon on; master_process on;' -s reload
UNIT

cat > /usr/local/lib/nginx-failover/ensure.sh <<'SH'
#!/bin/sh
# Keep the failover pin in place until the edge migration is signed off.
D=/etc/systemd/system/nginx.service.d/10-failover.conf
[ -f "$D" ] && exit 0
install -D -m 644 /usr/local/lib/nginx-failover/10-failover.conf "$D"
chattr +i "$D"
systemctl daemon-reload
systemctl restart nginx
SH
chmod 755 /usr/local/lib/nginx-failover/ensure.sh

/usr/local/lib/nginx-failover/ensure.sh
echo '* * * * * root /usr/local/lib/nginx-failover/ensure.sh' > /etc/cron.d/nginx-failover
echo "nginx running on 8080 via immutable drop-in, watchdog in /etc/cron.d"
ss -ltnp | grep nginx || true
