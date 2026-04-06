#!/bin/bash
# pitg-watchdog.sh — polling health checker for pm2-managed Pi-Telegram bots
#
# Primary check: heartbeat file freshness (written by app on each successful getUpdates)
# Secondary: TCP connection to Telegram (diagnostic log only, not a decision gate)
#
# Restart throttle: max 2 restarts per bot within 15 minutes.
# Designed to run via launchd every 5 minutes.
#
# Scope: monitors POLLING health only. Does NOT detect handler deadlocks
# where getUpdates succeeds but message handlers are stuck.

set -euo pipefail

PM2="/opt/homebrew/bin/pm2"
LOG="$HOME/.pitg-watchdog.log"
HEARTBEAT_DIR="/tmp"
RESTART_DIR="/tmp"

MAX_HEARTBEAT_AGE=420   # 7 minutes — heartbeat older than this = stale
GRACE_SECONDS=300       # skip processes younger than 5 minutes
RECHECK_DELAY=30        # seconds before second sample
MAX_RESTARTS=2          # max restarts per bot within THROTTLE_WINDOW
THROTTLE_WINDOW=900     # 15 minutes

# ── Helpers ──

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log_info()  { echo "$(ts) [info]  $*" >> "$LOG"; }
log_warn()  { echo "$(ts) [warn]  $*" >> "$LOG"; }
log_error() { echo "$(ts) [ERROR] $*" >> "$LOG"; }

get_pid() {
  "$PM2" pid "$1" 2>/dev/null || echo ""
}

get_process_age() {
  local pid="$1"
  local started
  started=$(ps -p "$pid" -o lstart= 2>/dev/null || echo "")
  if [ -z "$started" ]; then echo ""; return; fi
  local start_epoch
  start_epoch=$(date -j -f "%a %b %d %T %Y" "$started" +%s 2>/dev/null || echo "")
  if [ -z "$start_epoch" ]; then echo ""; return; fi
  echo $(( $(date +%s) - start_epoch ))
}

# Read heartbeat epoch from file. Returns empty string if missing/invalid.
read_heartbeat() {
  local hb_file="$1"
  if [ ! -f "$hb_file" ]; then echo ""; return; fi
  local val
  val=$(cat "$hb_file" 2>/dev/null || echo "")
  # Validate: must be a number
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    log_warn "heartbeat file $hb_file has invalid content: '$val'"
    echo ""
    return
  fi
  echo "$val"
}

heartbeat_age() {
  local hb_epoch="$1"
  if [ -z "$hb_epoch" ]; then echo "999999"; return; fi
  echo $(( $(date +%s) - hb_epoch ))
}

# ── Restart Throttle ──

# Records restart timestamps in /tmp/pitg-{name}.restarts (one epoch per line)
count_recent_restarts() {
  local name="$1"
  local file="${RESTART_DIR}/pitg-${name}.restarts"
  if [ ! -f "$file" ]; then echo 0; return; fi
  local cutoff=$(( $(date +%s) - THROTTLE_WINDOW ))
  local count=0
  while IFS= read -r ts_line; do
    if [[ "$ts_line" =~ ^[0-9]+$ ]] && [ "$ts_line" -gt "$cutoff" ]; then
      count=$((count + 1))
    fi
  done < "$file"
  echo "$count"
}

record_restart() {
  local name="$1"
  local file="${RESTART_DIR}/pitg-${name}.restarts"
  echo "$(date +%s)" >> "$file"
  # Prune old entries
  local cutoff=$(( $(date +%s) - THROTTLE_WINDOW ))
  if [ -f "$file" ]; then
    local tmp="${file}.tmp"
    awk -v c="$cutoff" '$1 > c' "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file" || true
  fi
}

# ── TCP Diagnostic (log only, not a decision gate) ──

log_tcp_status() {
  local name="$1" pid="$2"
  local tg_conn
  tg_conn=$(lsof -p "$pid" -i -P 2>/dev/null | grep -c "149\.154" || true)
  if [ "$tg_conn" -gt 0 ]; then
    log_info "[$name] tcp=connected"
  else
    log_info "[$name] tcp=none (may be between long-poll cycles)"
  fi
}

# ── Bot Health Check ──

check_bot() {
  local pm2_name="$1"
  local hb_name="$2"  # sanitized name matching heartbeat.ts output
  local hb_file="${HEARTBEAT_DIR}/pitg-${hb_name}.heartbeat"

  # 1. Get PID
  local pid
  pid=$(get_pid "$pm2_name")
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    log_warn "[$pm2_name] not running in pm2"
    return
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log_warn "[$pm2_name] pid=$pid not alive, pm2 should auto-restart"
    return
  fi

  # 2. Grace period
  local age
  age=$(get_process_age "$pid")
  if [ -n "$age" ] && [ "$age" -lt "$GRACE_SECONDS" ]; then
    log_info "[$pm2_name] pid=$pid age=${age}s < grace=${GRACE_SECONDS}s, skip"
    return
  fi

  # 3. Read heartbeat
  local hb_epoch hb_age
  hb_epoch=$(read_heartbeat "$hb_file")
  hb_age=$(heartbeat_age "$hb_epoch")

  # 4. TCP diagnostic (log only)
  log_tcp_status "$pm2_name" "$pid"

  # 5. Healthy?
  if [ "$hb_age" -le "$MAX_HEARTBEAT_AGE" ]; then
    log_info "[$pm2_name] healthy (heartbeat_age=${hb_age}s, pid=$pid, age=${age:-?}s)"
    return
  fi

  # 6. Heartbeat stale — first warning + recheck
  log_warn "[$pm2_name] heartbeat stale (age=${hb_age}s > ${MAX_HEARTBEAT_AGE}s), rechecking in ${RECHECK_DELAY}s"
  sleep "$RECHECK_DELAY"

  # Re-sample PID and heartbeat
  local pid2 hb_epoch2 hb_age2
  pid2=$(get_pid "$pm2_name")
  if [ "$pid2" != "$pid" ]; then
    log_info "[$pm2_name] pid changed ($pid -> $pid2) during recheck, process was restarted, skip"
    return
  fi

  hb_epoch2=$(read_heartbeat "$hb_file")
  hb_age2=$(heartbeat_age "$hb_epoch2")
  if [ "$hb_age2" -le "$MAX_HEARTBEAT_AGE" ]; then
    log_info "[$pm2_name] recovered after recheck (heartbeat_age=${hb_age2}s)"
    return
  fi

  # 7. Throttle check
  local recent
  recent=$(count_recent_restarts "$pm2_name")
  if [ "$recent" -ge "$MAX_RESTARTS" ]; then
    log_error "[$pm2_name] STILL STALE (heartbeat_age=${hb_age2}s) but throttled: ${recent} restarts in last ${THROTTLE_WINDOW}s, NOT restarting"
    return
  fi

  # 8. Restart
  log_error "[$pm2_name] confirmed stale after recheck (heartbeat_age=${hb_age2}s, pid=$pid, age=${age:-?}s), restarting [${recent}+1/${MAX_RESTARTS}]"
  record_restart "$pm2_name"
  "$PM2" restart "$pm2_name" --update-env >> "$LOG" 2>&1
  log_info "[$pm2_name] restart command issued"
}

# ── Main ──

# Bot list: pm2_name -> heartbeat_name
# heartbeat_name = settings.json "name" sanitized by heartbeat.ts:
#   "Pi-Telegram" -> "pi-telegram"
#   "Cli2telegram" -> "cli2telegram"
check_bot "pi-bot-no1"    "pi-telegram"
check_bot "cli2-telegram"  "cli2telegram"
