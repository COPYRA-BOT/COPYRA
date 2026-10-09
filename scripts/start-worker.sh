#!/bin/sh
# Dedicated App Platform worker — copy trading 24/7 + tiny /health for DO checks.
# If this component was created as a Web Service (HTTP health required), /health
# keeps the deploy green. Trading still runs in the supervised Node worker.
#
# Single-engine guarantee: flock on this supervisor + kill previous worker PID
# before each start so watchdog respawns never overlap two trading engines.
set -e

PORT="${PORT:-${HEALTH_PORT:-8080}}"
export PORT

LOCK=/tmp/copyra-worker-supervisor.lock
PIDFILE=/tmp/copyra-worker.pid

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

backoff=3
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
  npm run start -w @copyra/worker &
  WORKER_PID=$!
  echo "$WORKER_PID" > "$PIDFILE"
  backoff=3
  wait "$WORKER_PID" || true
  code=$?
  # Bounded backoff with light jitter (3s → 15s) so crash loops do not thrash RPC/DB.
  jitter=$(awk 'BEGIN{srand(); printf "%d", int(rand()*3)}' 2>/dev/null || echo 1)
  sleep_for=$((backoff + jitter))
  echo "COPYRA worker exited code=${code}; respawning in ${sleep_for}s..." >&2
  sleep "$sleep_for"
  if [ "$backoff" -lt 15 ]; then
    backoff=$((backoff + 3))
  fi
done
