#!/bin/sh
# One container, one image: API (HTTP + dashboard) + background worker.
#
# On basic-xxs, starting the worker before the API delays listen() and makes
# App Platform health checks fail → "Waiting for service" / Degraded during
# every deploy. Bring the API up first, then start the worker.
#
# The copy-trade worker MUST run 24/7. If it exits (watchdog stall, OOM, crash),
# respawn it forever — never leave the platform without a live monitor.
set -e

PORT="${PORT:-${API_PORT:-8080}}"

npm run start -w @copyra/api &
API_PID=$!
WORKER_PID=""
WORKER_SUPERVISOR_PID=""

cleanup() {
  if [ -n "${WORKER_SUPERVISOR_PID:-}" ]; then
    kill "$WORKER_SUPERVISOR_PID" 2>/dev/null || true
  fi
  if [ -f /tmp/copyra-worker.pid ]; then
    kill "$(cat /tmp/copyra-worker.pid)" 2>/dev/null || true
  fi
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait until the API accepts connections (health is registered before listen returns).
i=0
while [ "$i" -lt 90 ]; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "COPYRA API exited during boot" >&2
    exit 1
  fi
  if node -e "fetch('http://127.0.0.1:${PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "${RUN_WORKER:-true}" = "true" ]; then
  (
    # Supervisor loop — copy trading never stays down after a crash/stall exit.
    while true; do
      echo "COPYRA worker starting (24/7 supervisor)..."
      npm run start -w @copyra/worker &
      WORKER_PID=$!
      # Publish PID to parent via a file so cleanup can signal the child.
      echo "$WORKER_PID" > /tmp/copyra-worker.pid
      wait "$WORKER_PID" || true
      code=$?
      echo "COPYRA worker exited code=${code}; respawning in 3s..." >&2
      sleep 3
    done
  ) &
  WORKER_SUPERVISOR_PID=$!
fi

wait "$API_PID"
