#!/bin/bash
# Scenario 4: postgres moves to a non-default port, the app loses its database.
conf=$(ls /etc/postgresql/*/main/postgresql.conf | head -1)
grep -q "^port = 5433" "$conf" || echo "port = 5433" >> "$conf"
systemctl restart postgresql
echo "postgres now on 5433, app expects 5432"
