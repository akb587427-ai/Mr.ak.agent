#!/usr/bin/env bash
# Supervises the WhatsApp AI agent for long unattended runs.
#
# A plain restart-on-exit loop is not enough here: the process can stay alive while
# the web app stops answering or WhatsApp drops, and neither case would ever exit.
# This watchdog therefore judges health from the outside, by asking the app itself,
# and only restarts when the app cannot serve a customer.
cd "$(dirname "$0")" || exit 1
export PORT="${PORT:-12000}"
mkdir -p logs

CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
# How many consecutive bad checks before a restart. The app is allowed to be briefly
# unwell (a deploy, a WhatsApp reconnect) without being killed for it.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-4}"
# A restart that happens faster than this counts as a crash loop, and the delay grows
# so a permanently broken build does not spin the CPU forever.
MIN_UPTIME_BEFORE_TRUST="${MIN_UPTIME_BEFORE_TRUST:-60}"
LOG_FILE="logs/watchdog.log"
STATE_FILE="logs/watchdog.state"

rotate_log() {
  local file="$1" max="${2:-1048576}"
  [ -f "$file" ] || return 0
  local size
  size=$(stat -c %s "$file" 2>/dev/null || echo 0)
  if [ "$size" -gt "$max" ]; then
    mv -f "$file" "$file.1" 2>/dev/null
    : > "$file"
  fi
}

wlog() {
  rotate_log "$LOG_FILE" 524288
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

# Read one field out of /api/state. The response is small JSON, so a targeted grep
# avoids depending on a JSON tool being installed in this image.
read_state() {
  local json
  json=$(curl -s -m 8 "http://127.0.0.1:${PORT}/api/state" 2>/dev/null) || return 1
  [ -n "$json" ] || return 1
  WA_JSON="$json"
  return 0
}

wa_field() {
  printf '%s' "$WA_JSON" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed 's/.*:"//; s/"$//'
}

server_pid() {
  [ -f logs/server.pid ] && cat logs/server.pid 2>/dev/null
}

# Stop the whole supervision tree. SIGTERM first so a healthy app can close cleanly,
# then SIGKILL: a process that is stopped or wedged never gets around to handling the
# polite signal, and leaving it behind keeps the port bound so the replacement cannot
# start.
stop_server() {
  pkill -f "bash start.sh" 2>/dev/null
  pkill -f "node server.js" 2>/dev/null
  for _ in 1 2 3 4 5; do
    pgrep -f "node server.js" > /dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "node server.js" > /dev/null 2>&1; then
    wlog "server ignored SIGTERM — forcing it down"
    pkill -9 -f "bash start.sh" 2>/dev/null
    pkill -9 -f "node server.js" 2>/dev/null
    sleep 2
  fi
  # Wait for the port to be released, otherwise the new server cannot bind and would
  # crash-loop against the old listener.
  for _ in $(seq 1 15); do
    ss -ltn 2>/dev/null | grep -q ":${PORT} " || break
    sleep 1
  done
}

start_server() {
  stop_server
  setsid nohup bash start.sh >> logs/watchdog.log 2>&1 < /dev/null &
  echo $! > logs/server.pid
  date +%s > logs/server.started
  # Give it a moment to bind, then say whether it actually came up, so the log shows
  # a real outcome instead of just the intent.
  for _ in $(seq 1 20); do
    if curl -s -m 3 -o /dev/null "http://127.0.0.1:${PORT}/api/state" 2>/dev/null; then
      wlog "started server (pid $(cat logs/server.pid)) and it is answering"
      return 0
    fi
    sleep 1
  done
  wlog "started server (pid $(cat logs/server.pid)) but it is not answering yet"
}

restart_wa() {
  wlog "asking app to re-link WhatsApp"
  curl -s -m 10 -X POST "http://127.0.0.1:${PORT}/api/restart" > /dev/null 2>&1
}

log_crashes() {
  # start.sh appends this line every time the node process exits on its own, so a
  # rising count between checks means the app is crashing rather than being restarted
  # by us.
  grep -c "server exited" logs/server.log 2>/dev/null
}

wlog "watchdog up (port ${PORT}, interval ${CHECK_INTERVAL}s)"

# If nothing is serving yet (a fresh boot, or the app was stopped), bring it up at
# once instead of waiting out the failure threshold.
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:${PORT}/api/state" 2>/dev/null; then
  wlog "no server answering at startup — starting it now"
  start_server
  sleep 15
fi

fails=0
wa_bad=0
last_crash_count=$(log_crashes)

while true; do
  sleep "$CHECK_INTERVAL"

  # Keep the log from filling the disk on a long run.
  rotate_log logs/server.log 5242880

  pid=$(server_pid)
  alive=0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    alive=1
  fi

  # The web app is the source of truth: if it answers, the process is genuinely
  # serving, not merely present in the process table.
  serving=0
  if [ "$alive" -eq 1 ] && read_state; then
    serving=1
  fi

  if [ "$serving" -eq 0 ]; then
    fails=$((fails + 1))
    crashes=$(log_crashes)
    if [ "$crashes" != "$last_crash_count" ]; then
      wlog "server exited on its own (crash counter ${last_crash_count} -> ${crashes})"
      last_crash_count="$crashes"
    fi
    wlog "web app not answering, check ${fails}/${FAIL_THRESHOLD} (alive=${alive})"

    if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
      # A server that dies again within a minute of starting is not a transient fault;
      # back off so a broken build cannot burn the machine.
      backoff=5
      if [ -f logs/server.started ]; then
        uptime_s=$(( $(date +%s) - $(cat logs/server.started) ))
        if [ "$uptime_s" -lt "$MIN_UPTIME_BEFORE_TRUST" ]; then
          backoff=$(( uptime_s < 20 ? 60 : 20 ))
          wlog "server only lived ${uptime_s}s — backing off ${backoff}s"
        fi
      fi
      start_server
      fails=0
      wa_bad=0
      sleep "$backoff"
    fi
    continue
  fi

  if [ "$fails" -gt 0 ]; then wlog "web app answering again after ${fails} bad check(s)"; fi
  fails=0

  # The app is up, so now look at WhatsApp. It reconnects on its own, so a short
  # spell of reconnecting is normal and must not cost a restart.
  status=$(wa_field status)
  case "$status" in
    reconnecting)
      wa_bad=$((wa_bad + 1))
      wlog "WhatsApp reconnecting (${wa_bad} consecutive)"
      if [ "$wa_bad" -ge 6 ]; then
        restart_wa
        wa_bad=0
        sleep 45
      fi
      ;;
    logged_out)
      wlog "WhatsApp logged out — a new QR scan is needed from the dashboard"
      sleep 300
      ;;
    *)
      wa_bad=0
      ;;
  esac
done
