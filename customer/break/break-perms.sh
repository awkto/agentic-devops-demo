#!/bin/bash
# Web root unreadable by the nginx worker: 403, not a dead service.
chmod 000 /var/www/html/index.html
echo "index.html permissions set to 000"
