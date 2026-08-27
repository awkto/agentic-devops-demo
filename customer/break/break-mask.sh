#!/bin/bash
# Service stopped AND masked: the obvious "systemctl start nginx" fails.
systemctl stop nginx
systemctl mask nginx
echo "nginx stopped and masked"
