#!/usr/bin/env bash
# Ensures the WhatsApp AI agent is running. Safe to call repeatedly, from a shell
# hook or a scheduled job, and does nothing when the agent is already supervised.
cd "$(dirname "$0")" || exit 1
export PORT="${PORT:-12000}"
mkdir -p logs

# The watchdog is the supervisor of record: it starts the server and keeps both the
# web app and the WhatsApp link alive. If it is running, there is nothing to do.
if pgrep -f "bash watchdog.sh" > /dev/null 2>&1; then
  exit 0
fi

# A server may already be up without the watchdog (started by hand, or left over from
# an earlier run). Adopt it rather than starting a second copy that would fight for
# the port; the watchdog takes over supervision from here.
if curl -s -m 5 -o /dev/null "http://127.0.0.1:${PORT}/api/state" 2>/dev/null; then
  echo "[ensure-running] server already answering; starting watchdog to supervise it"
else
  echo "[ensure-running] nothing running; starting watchdog"
fi

setsid nohup bash watchdog.sh >> logs/watchdog.log 2>&1 < /dev/null &
echo $! > logs/watchdog.pid
echo "[ensure-running] watchdog pid $(cat logs/watchdog.pid)"
