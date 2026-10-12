#!/bin/sh
# Dedicated App Platform sniper worker — launch discovery + sniper exits + /health.
# Independent of the copy-trade worker so CPU/locks never starve each other.
# Hung processes are SIGKILL'd when the sniper status file goes stale.
set -e

PORT="${PORT:-${HEALTH_PORT:-8080}}"
export PORT
# So worker-health.mjs reports copyra-sniper-worker + reads sniper status file.
export COPYRA_HEALTH_ROLE=sniper

LOCK=/tmp/copyra-sniper-supervisor.lock
PIDFILE=/tmp/copyra-sniper-worker.pid
STATUS=/tmp/copyra-sniper-status.json
STALE_SEC="${COPYRA_WORKER_STALE_SEC:-120}"

echo "COPYRA sniper worker (24/7 supervisor + health :${PORT})"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "COPYRA sniper supervisor already running (lock held) — exiting" >&2
  exit 1
fi

node /app/scripts/worker-health.mjs &
HEALTH_PID=$!

cleanup() {
  kill "$HEALTH_PID" 2>/dev/null || true
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}
trap cleanup EXIT INT TERM

status_age_sec() {
  if [ ! -f "$STATUS" ]; then
    echo 99999
    return
  fi
  mtime=$(stat -c %Y "$STATUS" 2>/dev/null || stat -f %m "$STATUS" 2>/dev/null || echo 0)
  now=$(date +%s)
  echo $((now - mtime))
}

backoff=5
while true; do
  if [ -f "$PIDFILE" ]; then
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      echo "COPYRA stopping leftover sniper pid=${old}" >&2
      kill "$old" 2>/dev/null || true
      sleep 1
      kill -9 "$old" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi

  echo "COPYRA sniper worker starting..."
  rm -f "$STATUS"
  npm run start -w @copyra/sniper-worker &
  WORKER_PID=$!
  echo "$WORKER_PID" > "$PIDFILE"

  while kill -0 "$WORKER_PID" 2>/dev/null; do
    sleep 15
    age=$(status_age_sec)
    if [ "$age" -gt "$STALE_SEC" ]; then
      up_approx=$(( $(date +%s) - $(stat -c %Y "$PIDFILE" 2>/dev/null || date +%s) ))
      if [ "$up_approx" -gt 60 ]; then
        echo "COPYRA sniper status stale ${age}s — SIGKILL hung pid=${WORKER_PID}" >&2
        kill -9 "$WORKER_PID" 2>/dev/null || true
        break
      fi
    fi
  done
  wait "$WORKER_PID" || true
  code=$?
  jitter=$(awk 'BEGIN{srand(); printf "%d", int(rand()*5)}' 2>/dev/null || echo 2)
  sleep_for=$((backoff + jitter))
  echo "COPYRA sniper worker exited code=${code}; respawning in ${sleep_for}s..." >&2
  sleep "$sleep_for"
  if [ "$backoff" -lt 45 ]; then
    backoff=$((backoff + 5))
  fi
done
