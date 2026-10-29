#!/usr/bin/env bash
# Ensures the WhatsApp AI agent is running. Safe to call repeatedly.
# Starts the server detached if port 12000 is not already serving.
cd "$(dirname "$0")" || exit 1
export PORT="${PORT:-12000}"
mkdir -p logs

if curl -s -m 3 -o /dev/null "http://127.0.0.1:${PORT}/api/state"; then
  exit 0
fi

if [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  exit 0
fi

setsid nohup bash start.sh > /dev/null 2>&1 < /dev/null &
echo $! > logs/server.pid
echo "[ensure-running] started WhatsApp agent on port ${PORT}"
