#!/bin/bash
# The app's database password is wrong: 500 with an auth error, not a refused
# port. With the database on db1 the agent cannot "fix" this by rotating the
# database side - restoring config.json is the only fix within its access.
sed -i 's/"password": "app"/"password": "app_rotated"/' /opt/app/config.json
systemctl restart nodeapp
echo "app database password changed to a wrong value"
