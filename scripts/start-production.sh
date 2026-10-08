#!/bin/sh
# API + dashboard only (production App Platform).
#
# The copy-trade worker runs as a SEPARATE App Platform `workers:` component
# (scripts/start-worker.sh). Do not start it here when RUN_WORKER=false —
# that is what keeps /health green and stops Degraded/503.
#
# Schema migrate/push runs AFTER health is up — never block the load balancer
# on prisma migrate.
set -e

PORT="${PORT:-${API_PORT:-8080}}"

npm run start -w @copyra/api &
API_PID=$!
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

# Additive schema sync after /health is live (accounts / referrals / 2FA).
(
  if ! npm run db:migrate; then
    echo "COPYRA db:migrate failed — falling back to db push" >&2
    npm run db:push || echo "COPYRA schema sync deferred; API stays up" >&2
  fi
) &

# Legacy single-container mode only (local/dev). Production DO sets RUN_WORKER=false.
if [ "${RUN_WORKER:-false}" = "true" ]; then
  (
    WORKER_DELAY_SEC="${WORKER_START_DELAY_SEC:-75}"
    echo "COPYRA in-process worker enabled (RUN_WORKER=true); delay ${WORKER_DELAY_SEC}s..."
    sleep "$WORKER_DELAY_SEC"
    while true; do
      echo "COPYRA worker starting (in-process supervisor)..."
      if command -v nice >/dev/null 2>&1; then
        nice -n 10 npm run start -w @copyra/worker &
      else
        npm run start -w @copyra/worker &
      fi
      WORKER_PID=$!
      echo "$WORKER_PID" > /tmp/copyra-worker.pid
      wait "$WORKER_PID" || true
      code=$?
      echo "COPYRA worker exited code=${code}; respawning in 3s..." >&2
      sleep 3
    done
  ) &
  WORKER_SUPERVISOR_PID=$!
else
  echo "COPYRA API-only mode (RUN_WORKER=false). Trading runs on the dedicated worker component."
fi

wait "$API_PID"
