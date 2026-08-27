#!/bin/bash
# Port 80 dropped at the firewall: fine on the box, dead from outside.
iptables -I INPUT -p tcp --dport 80 -j DROP
echo "inbound tcp/80 dropped (nginx still serving on localhost)"
