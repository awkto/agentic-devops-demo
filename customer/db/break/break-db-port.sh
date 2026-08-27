#!/bin/bash
# Variant: postgres moves to a non-default port. Same restricted-host story,
# subtler diagnosis (unit healthy, port wrong).
conf=$(ls /etc/postgresql/*/main/postgresql.conf | head -1)
grep -q "^port = 5433" "$conf" || echo "port = 5433" >> "$conf"
systemctl restart postgresql
echo "postgres now on 5433, app expects 5432"
