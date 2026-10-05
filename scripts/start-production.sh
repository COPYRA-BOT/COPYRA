#!/bin/sh
# One container, one image build: API (HTTP + dashboard) + background worker.
set -e

if [ "${RUN_WORKER:-true}" = "true" ]; then
  npm run start -w @copyra/worker &
  WORKER_PID=$!
  trap 'kill "$WORKER_PID" 2>/dev/null || true' EXIT INT TERM
fi

exec npm run start -w @copyra/api
