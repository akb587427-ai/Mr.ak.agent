#!/usr/bin/env bash
cd "$(dirname "$0")"
export PORT="${PORT:-12000}"
while true; do
  node server.js
  echo "[start.sh] server exited ($?), restarting in 2s"
  sleep 2
done
