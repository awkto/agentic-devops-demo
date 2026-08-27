#!/bin/bash
# The restricted-host scenario: postgres dies on db1. The agent can see it
# (logs, unit state) but cannot fix it - dbops has no sudo and the harness
# blocks writes on this system.
systemctl stop postgresql
echo "postgresql stopped on db1 - nodeapp on cust1 will fail too"
