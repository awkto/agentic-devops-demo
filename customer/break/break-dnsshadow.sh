#!/bin/bash
# Scenario: the account service cannot reach its database, but the database is
# fine. A hosts-file entry on cust1 points db1 at an unroutable address. dig
# still returns the real IP (it skips /etc/hosts), so DNS looks healthy.
set -e
grep -q '^192.0.2.50 db1' /etc/hosts || sed -i '1i 192.0.2.50 db1.gobyl.cc db1' /etc/hosts
systemctl restart nodeapp
echo "db1 now resolves to $(getent hosts db1.gobyl.cc) on cust1"
