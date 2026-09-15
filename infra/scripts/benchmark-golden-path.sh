#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_LOG="$(mktemp)"
TARGET_PID=""

cleanup() {
  if [[ -n "$TARGET_PID" ]]; then
    kill -TERM "$TARGET_PID" 2>/dev/null || true
    wait "$TARGET_PID" 2>/dev/null || true
  fi
  rm -f "$TARGET_LOG"
}
trap cleanup EXIT

node "$ROOT/scripts/golden-path-load-target.mjs" >"$TARGET_LOG" 2>&1 &
TARGET_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3939/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$TARGET_PID" 2>/dev/null; then
    cat "$TARGET_LOG" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:3939/health >/dev/null || {
  cat "$TARGET_LOG" >&2
  echo "golden-path load target did not become ready" >&2
  exit 1
}

mkdir -p "$ROOT/docs/benchmarks"
docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -e HORIZON_K6_STAGE_DURATION="${HORIZON_K6_STAGE_DURATION:-15s}" \
  -v "$ROOT/scripts:/scripts:ro" \
  -v "$ROOT/docs/benchmarks:/results" \
  grafana/k6:1.3.0 run /scripts/golden-path.k6.js \
  --summary-export /results/golden-path-summary.json
