#!/bin/bash
# The customer's page is gone from the web root; nginx is untouched and healthy.
mv /var/www/html/index.html /root/index.html.parked
echo "index.html moved out of the web root (nginx still running)"
