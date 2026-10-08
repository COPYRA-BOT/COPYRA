#!/bin/sh
# Dedicated App Platform worker — copy trading 24/7 + tiny /health for DO checks.
# If this component was created as a Web Service (HTTP health required), /health
# keeps the deploy green. Trading still runs in the supervised Node worker.
set -e

PORT="${PORT:-${HEALTH_PORT:-8080}}"
export PORT

echo "COPYRA dedicated copy-trade worker (24/7 supervisor + health :${PORT})"

# Health first so App Platform marks the component ready immediately.
node /app/scripts/worker-health.mjs &
HEALTH_PID=$!

cleanup() {
  kill "$HEALTH_PID" 2>/dev/null || true
  if [ -f /tmp/copyra-worker.pid ]; then
    kill "$(cat /tmp/copyra-worker.pid)" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

while true; do
  echo "COPYRA worker starting..."
  npm run start -w @copyra/worker &
  WORKER_PID=$!
  echo "$WORKER_PID" > /tmp/copyra-worker.pid
  wait "$WORKER_PID" || true
  code=$?
  echo "COPYRA worker exited code=${code}; respawning in 3s..." >&2
  sleep 3
done
