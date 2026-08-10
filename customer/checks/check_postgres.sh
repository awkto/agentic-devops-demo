#!/bin/bash
# Nagios-style check run by Icinga over ssh.
out=$(sudo -u postgres pg_isready 2>&1)
if [ $? -eq 0 ]; then
  echo "OK - $out"
  exit 0
else
  echo "CRITICAL - $out"
  exit 2
fi
