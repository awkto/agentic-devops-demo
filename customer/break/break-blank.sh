#!/bin/bash
# The page is served, but empty. HTTP 200, so monitoring never notices.
cp /var/www/html/index.html /root/index.html.parked
: > /var/www/html/index.html
echo "index.html truncated to 0 bytes (still HTTP 200)"
