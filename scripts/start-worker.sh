#!/bin/sh
# Dedicated App Platform worker component — copy trading only (no HTTP).
# Separated from the API so Solana/EVM load can never flip /health → Degraded.
set -e

echo "COPYRA dedicated copy-trade worker (24/7 supervisor)"

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
