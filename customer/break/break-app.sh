#!/bin/bash
# Scenario 3: the application config goes missing, nodeapp crash-loops.
mv /opt/app/config.json /root/config.json.old
systemctl restart nodeapp
echo "nodeapp config removed, unit will crash-loop"
