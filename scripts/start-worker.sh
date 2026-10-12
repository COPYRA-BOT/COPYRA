#!/bin/sh
# Dedicated App Platform worker — copy trading 24/7 + tiny /health for DO checks.
# If this component was created as a Web Service (HTTP health required), /health
# keeps the deploy green. Trading still runs in the supervised Node worker.
#
# Single-engine guarantee: flock on this supervisor + kill previous worker PID
# before each start so watchdog respawns never overlap two trading engines.
# Hung processes (event-loop freeze) are SIGKILL'd when the status file goes stale.
set -e

PORT="${PORT:-${HEALTH_PORT:-8080}}"
export PORT

LOCK=/tmp/copyra-worker-supervisor.lock
PIDFILE=/tmp/copyra-worker.pid
STATUS=/tmp/copyra-worker-status.json
# If heartbeats/status stop updating, the Node process is hung — kill and respawn.
STALE_SEC="${COPYRA_WORKER_STALE_SEC:-120}"

echo "COPYRA dedicated copy-trade worker (24/7 supervisor + health :${PORT})"

# Only one supervisor loop per container.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "COPYRA worker supervisor already running (lock held) — exiting" >&2
  exit 1
fi

# Health first so App Platform marks the component ready immediately.
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
  # GNU stat (DO) or BSD stat fallback.
  mtime=$(stat -c %Y "$STATUS" 2>/dev/null || stat -f %m "$STATUS" 2>/dev/null || echo 0)
  now=$(date +%s)
  echo $((now - mtime))
}

backoff=5
while true; do
  # Ensure no leftover engine from a previous crash/respawn.
  if [ -f "$PIDFILE" ]; then
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      echo "COPYRA stopping leftover worker pid=${old}" >&2
      kill "$old" 2>/dev/null || true
      sleep 1
      kill -9 "$old" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi

  echo "COPYRA worker starting..."
  rm -f "$STATUS"
  npm run start -w @copyra/worker &
  WORKER_PID=$!
  echo "$WORKER_PID" > "$PIDFILE"

  # Wait for exit OR hung status (do not block forever on a frozen Node process).
  while kill -0 "$WORKER_PID" 2>/dev/null; do
    sleep 15
    age=$(status_age_sec)
    # Grace period after boot before stale-kill.
    if [ "$age" -gt "$STALE_SEC" ]; then
      up_approx=$(( $(date +%s) - $(stat -c %Y "$PIDFILE" 2>/dev/null || date +%s) ))
      if [ "$up_approx" -gt 60 ]; then
        echo "COPYRA worker status stale ${age}s — SIGKILL hung pid=${WORKER_PID}" >&2
        kill -9 "$WORKER_PID" 2>/dev/null || true
        break
      fi
    fi
  done
  wait "$WORKER_PID" || true
  code=$?
  # Bounded backoff with light jitter (5s → 45s) so crash loops do not thrash
  # RPC/DB or make DigitalOcean report "Containers repeatedly crashing".
  jitter=$(awk 'BEGIN{srand(); printf "%d", int(rand()*5)}' 2>/dev/null || echo 2)
  sleep_for=$((backoff + jitter))
  echo "COPYRA worker exited code=${code}; respawning in ${sleep_for}s..." >&2
  sleep "$sleep_for"
  if [ "$backoff" -lt 45 ]; then
    backoff=$((backoff + 5))
  fi
done
