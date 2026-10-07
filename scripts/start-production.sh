#!/bin/sh
# One container, one image: API (HTTP + dashboard) + background worker.
#
# On basic-xxs, starting the worker before the API delays listen() and makes
# App Platform health checks fail → "Waiting for service" / Degraded during
# every deploy. Bring the API up first, then start the worker.
set -e

PORT="${PORT:-${API_PORT:-8080}}"

npm run start -w @copyra/api &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  if [ -n "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
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
  npm run start -w @copyra/worker &
  WORKER_PID=$!
fi

wait "$API_PID"
