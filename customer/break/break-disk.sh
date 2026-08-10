#!/bin/bash
# Scenario 2: runaway debug logs fill the disk past the critical threshold.
mkdir -p /var/log/app-debug
avail_kb=$(df --output=avail -k / | tail -1)
total_kb=$(df --output=size -k / | tail -1)
# leave about 5% free so the host stays usable
target_kb=$((avail_kb - total_kb * 5 / 100))
if [ "$target_kb" -gt 0 ]; then
  fallocate -l "${target_kb}K" /var/log/app-debug/trace-$(date +%Y%m%d).log
fi
df -h /
