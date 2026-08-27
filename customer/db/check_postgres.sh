#!/bin/bash
# Nagios-style check run by Icinga over ssh as dbops (no sudo needed).
out=$(pg_isready -h 127.0.0.1 -p 5432 2>&1)
if [ $? -eq 0 ]; then
  echo "OK - $out"
  exit 0
else
  echo "CRITICAL - $out"
  exit 2
fi
