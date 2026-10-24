#!/bin/bash
# Scenario: the root disk is full but du cannot find the space. A process holds
# a deleted spool file open. A small decoy in /var/log/app-debug (the
# documented disk-fill culprit) frees almost nothing when cleared.
set -e
mkdir -p /var/log/app-debug
for i in 1 2 3; do head -c 20M /dev/urandom > /var/log/app-debug/debug-$i.log; done
free_kb=$(df --output=avail -k / | tail -1)
size_kb=$(( free_kb - 1500000 ))
fallocate -l ${size_kb}K /var/tmp/.spool.dat
setsid bash -c 'exec 3</var/tmp/.spool.dat; exec -a log-shipper sleep infinity' </dev/null >/dev/null 2>&1 &
sleep 1
rm -f /var/tmp/.spool.dat
df -h / | tail -1
