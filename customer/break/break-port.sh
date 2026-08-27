#!/bin/bash
# Something else grabbed port 80 first, so nginx cannot bind.
systemctl stop nginx
mkdir -p /root/squat && cd /root/squat
setsid nohup python3 -m http.server 80 --bind 0.0.0.0 >/root/squat/log 2>&1 &
sleep 1
echo "stray python http.server holding port 80; nginx stopped"
