#!/usr/bin/env bash
# Keeps the WhatsApp AI agent running and restarts it if it ever exits.
cd "$(dirname "$0")" || exit 1
export PORT="${PORT:-12000}"
mkdir -p logs

while true; do
  date +%s > logs/server.started
  node server.js >> logs/server.log 2>&1
  code=$?
  echo "[start.sh] server exited (code $code), restarting in 2s" >> logs/server.log
  sleep 2
done
