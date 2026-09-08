#!/usr/bin/env bash
#
# Prove the platform actually works, rather than that it started.
#
# "docker compose up" reports success when processes exist. This asserts the things
# Horizon depends on: that RLS can be enforced because the application role cannot
# bypass it, that a trace reaches Jaeger and its log reaches Loki carrying the same
# trace id, that Prometheus scraped a metric that went through the Collector, that
# Grafana came up already wired, that the registry accepts a publish and serves it back,
# and that the gateway rejects a token it should reject.
#
# Exits non-zero on the first failure. Runs in CI.

set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"

# Host ports may be overridden in infra/.env (see infra/.env.example).
[[ -f "$INFRA_DIR/.env" ]] && set -a && . "$INFRA_DIR/.env" && set +a

PG_PORT="${HORIZON_POSTGRES_PORT:-5432}"
REDIS_PORT="${HORIZON_REDIS_PORT:-6379}"
RABBIT_UI_PORT="${HORIZON_RABBITMQ_UI_PORT:-15672}"
VERDACCIO_PORT="${HORIZON_VERDACCIO_PORT:-4873}"
OTLP_HTTP_PORT="${HORIZON_OTLP_HTTP_PORT:-4318}"
COLLECTOR_METRICS_PORT="${HORIZON_COLLECTOR_METRICS_PORT:-8889}"
COLLECTOR_HEALTH_PORT="${HORIZON_COLLECTOR_HEALTH_PORT:-13133}"
JAEGER_PORT="${HORIZON_JAEGER_PORT:-16686}"
PROMETHEUS_PORT="${HORIZON_PROMETHEUS_PORT:-9090}"
LOKI_PORT="${HORIZON_LOKI_PORT:-3100}"
ALLOY_PORT="${HORIZON_ALLOY_PORT:-12345}"
GRAFANA_PORT="${HORIZON_GRAFANA_PORT:-3300}"
KONG_PROXY_PORT="${HORIZON_KONG_PROXY_PORT:-8000}"

PASS=0
FAIL=0
FAILURES=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  %s %s\n' "$(green ✓)" "$name"
    PASS=$((PASS + 1))
  else
    printf '  %s %s\n' "$(red ✗)" "$name"
    FAIL=$((FAIL + 1))
    FAILURES+=("$name")
  fi
}

# Retry a check for up to N seconds — telemetry pipelines are eventually consistent by
# design (batching in the Collector, a 15s Prometheus scrape interval).
retry() {
  local seconds="$1"; shift
  local deadline=$(( SECONDS + seconds ))
  until "$@" >/dev/null 2>&1; do
    [[ $SECONDS -ge $deadline ]] && return 1
    sleep 2
  done
  return 0
}

section() { printf '\n%s\n' "$(dim "── $1")"; }

# --------------------------------------------------------------- containers
section "containers"

compose_ps() {
  docker compose -f "$INFRA_DIR/docker-compose.yml" --env-file "$INFRA_DIR/.env" ps --format json 2>/dev/null \
    || docker compose -f "$INFRA_DIR/docker-compose.yml" ps --format json 2>/dev/null
}

for service in postgres redis rabbitmq verdaccio otel-collector jaeger prometheus loki alloy grafana kong; do
  check "$service is running" bash -c \
    "docker inspect horizon-$service --format '{{.State.Running}}' 2>/dev/null | grep -q true"
done

# --------------------------------------------------------------- data
section "data services"

check "postgres accepts connections" \
  docker exec horizon-postgres pg_isready -U postgres -d postgres

check "five module databases exist" bash -c \
  "test \"\$(docker exec horizon-postgres psql -U postgres -tAc \"SELECT count(*) FROM pg_database WHERE datname LIKE 'horizon_%'\")\" = 5"

# The claim ADR 0017 rests on. If the application role could bypass RLS, every tenant
# isolation test in the repository would pass without proving anything.
check "application role cannot bypass RLS or escalate" bash -c \
  "test \"\$(docker exec horizon-postgres psql -U postgres -tAc \"SELECT rolsuper OR rolbypassrls OR rolcreaterole FROM pg_roles WHERE rolname='horizon_app'\")\" = f"

check "migration owner is a separate role" bash -c \
  "docker exec horizon-postgres psql -U postgres -tAc \"SELECT 1 FROM pg_roles WHERE rolname='horizon_owner'\" | grep -q 1"

check "debug role has stats access but no superuser" bash -c \
  "docker exec horizon-postgres psql -U postgres -tAc \"SELECT rolsuper FROM pg_roles WHERE rolname='horizon_debug'\" | grep -q f"

check "pg_stat_statements available" bash -c \
  "docker exec horizon-postgres psql -U postgres -d horizon_identity -tAc \"SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'\" | grep -q 1"

check "redis responds to PING" bash -c \
  "docker exec horizon-redis redis-cli ping | grep -q PONG"

check "rabbitmq node is running" \
  docker exec horizon-rabbitmq rabbitmq-diagnostics -q check_running

check "rabbitmq management api answers" bash -c \
  "curl -sf -u horizon:horizon http://localhost:$RABBIT_UI_PORT/api/overview | grep -q rabbitmq_version"

# --------------------------------------------------------------- registry
section "registry"

check "verdaccio answers" bash -c \
  "curl -sf http://localhost:$VERDACCIO_PORT/-/ping >/dev/null"

check "publish and install round trip" bash -c "
  set -e
  cd '$ROOT_DIR/contracts'
  npm run build >/dev/null 2>&1
  npm publish --registry http://localhost:$VERDACCIO_PORT \
    --//localhost:$VERDACCIO_PORT/:_authToken=local-smoke --force >/dev/null 2>&1 || true
  D=\$(mktemp -d)
  cd \"\$D\"
  npm init -y >/dev/null 2>&1
  printf '@horizon:registry=http://localhost:$VERDACCIO_PORT\n' > .npmrc
  npm install @horizon/contracts --no-audit --no-fund >/dev/null 2>&1
  test -f node_modules/@horizon/contracts/package.json
  rm -rf \"\$D\"
"

# --------------------------------------------------------------- observability
section "observability plane"

# Distroless images: no shell inside, so readiness is asserted from here rather than by
# a container healthcheck. See the note in docker-compose.yml.
check "collector is healthy" bash -c \
  "curl -sf http://localhost:$COLLECTOR_HEALTH_PORT/ >/dev/null"

check "alloy is ready" bash -c \
  "curl -sf http://localhost:$ALLOY_PORT/-/ready >/dev/null"

check "jaeger ui answers" bash -c \
  "curl -sf http://localhost:$JAEGER_PORT/ >/dev/null"

check "prometheus is healthy" bash -c \
  "curl -sf http://localhost:$PROMETHEUS_PORT/-/healthy >/dev/null"

check "loki is ready" bash -c \
  "curl -sf http://localhost:$LOKI_PORT/ready >/dev/null"

check "grafana is healthy" bash -c \
  "curl -sf http://localhost:$GRAFANA_PORT/api/health >/dev/null"

# --- the pipeline, end to end -------------------------------------------------
TRACE_ID="$(openssl rand -hex 16)"
SPAN_ID="$(openssl rand -hex 8)"
NOW_NS="$(( $(date +%s) * 1000000000 ))"
RUN_ID="$(openssl rand -hex 4)"

emit() {
  curl -sf -X POST -H 'Content-Type: application/json' -d "@$1" \
    "http://localhost:$OTLP_HTTP_PORT/v1/$2" >/dev/null
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/trace.json" <<JSON
{"resourceSpans":[{"resource":{"attributes":[
 {"key":"service.name","value":{"stringValue":"smoke"}},
 {"key":"deployment.environment","value":{"stringValue":"local"}}]},
 "scopeSpans":[{"scope":{"name":"smoke"},"spans":[{
  "traceId":"$TRACE_ID","spanId":"$SPAN_ID","name":"smoke-$RUN_ID","kind":2,
  "startTimeUnixNano":"$NOW_NS","endTimeUnixNano":"$(( NOW_NS + 5000000 ))",
  "status":{"code":1}}]}]}]}
JSON

cat > "$TMP/log.json" <<JSON
{"resourceLogs":[{"resource":{"attributes":[
 {"key":"service.name","value":{"stringValue":"smoke"}}]},
 "scopeLogs":[{"logRecords":[{
  "timeUnixNano":"$NOW_NS","severityNumber":9,"severityText":"INFO",
  "body":{"stringValue":"horizon platform smoke $RUN_ID"},
  "traceId":"$TRACE_ID","spanId":"$SPAN_ID"}]}]}]}
JSON

cat > "$TMP/metric.json" <<JSON
{"resourceMetrics":[{"resource":{"attributes":[
 {"key":"service.name","value":{"stringValue":"smoke"}}]},
 "scopeMetrics":[{"metrics":[{
  "name":"horizon_smoke_total","unit":"1",
  "sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[
   {"asInt":"1","startTimeUnixNano":"$NOW_NS","timeUnixNano":"$NOW_NS"}]}}]}]}]}
JSON

check "collector accepts OTLP traces"  emit "$TMP/trace.json" traces
check "collector accepts OTLP logs"    emit "$TMP/log.json" logs
check "collector accepts OTLP metrics" emit "$TMP/metric.json" metrics

check "trace reaches jaeger" retry 45 bash -c \
  "curl -sf 'http://localhost:$JAEGER_PORT/api/traces/$TRACE_ID' | grep -q '$SPAN_ID'"

# The correlation that makes an investigation possible: the log carries the same trace
# id as the span, so Grafana can link one to the other (ADR 0033).
check "log reaches loki carrying the trace id" retry 45 bash -c \
  "curl -sf -G 'http://localhost:$LOKI_PORT/loki/api/v1/query_range' \
     --data-urlencode 'query={service_name=\"smoke\"}' \
     --data-urlencode 'start=$(( $(date +%s) - 600 ))000000000' | grep -q '$TRACE_ID'"

check "metric re-exposed by the collector" retry 30 bash -c \
  "curl -sf http://localhost:$COLLECTOR_METRICS_PORT/metrics | grep -q horizon_smoke_total"

check "metric scraped into prometheus" retry 60 bash -c \
  "curl -sf -G 'http://localhost:$PROMETHEUS_PORT/api/v1/query' \
     --data-urlencode 'query=horizon_smoke_total' | grep -q '\"result\":\[{'"

check "alloy is shipping container logs to loki" retry 60 bash -c \
  "curl -sf -G 'http://localhost:$LOKI_PORT/loki/api/v1/query_range' \
     --data-urlencode 'query={source=\"docker\"}' \
     --data-urlencode 'start=$(( $(date +%s) - 600 ))000000000' | grep -q '\"values\"'"

check "grafana datasources provisioned from files" bash -c \
  "curl -sf -u admin:admin http://localhost:$GRAFANA_PORT/api/datasources | grep -q prometheus"

check "grafana dashboard provisioned from files" bash -c \
  "curl -sf -u admin:admin 'http://localhost:$GRAFANA_PORT/api/search?query=Horizon' | grep -q horizon-overview"

# --------------------------------------------------------------- gateway
section "gateway"

check "kong is healthy" docker exec horizon-kong kong health

if [[ -f "$INFRA_DIR/keys/ed25519-dev-1-private.pem" ]]; then
  TOKEN="$(node "$INFRA_DIR/scripts/mint-dev-token.mjs" 2>/dev/null)"
  BOGUS="$(node "$INFRA_DIR/scripts/mint-dev-token.mjs" --bogus 2>/dev/null)"

  status() {
    curl -s -o /dev/null -w '%{http_code}' "$@"
  }

  check "gateway accepts a valid EdDSA token" bash -c \
    "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $TOKEN' http://localhost:$KONG_PROXY_PORT/gateway/verify)\" = 200"

  # The check that matters: a well-formed token signed by a key the gateway has never
  # seen must not get through.
  check "gateway rejects a token signed by an unknown key" bash -c \
    "test \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $BOGUS' http://localhost:$KONG_PROXY_PORT/gateway/verify)\" = 401"

  check "gateway rejects a request with no token" bash -c \
    "test \"\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$KONG_PROXY_PORT/gateway/verify)\" = 401"
else
  printf '  %s no dev keys — run `make keys` to include the gateway JWT checks\n' "$(red '!')"
  FAIL=$((FAIL + 1))
  FAILURES+=("dev keys missing")
fi

check "gateway emits a correlation id" bash -c \
  "curl -sI http://localhost:$KONG_PROXY_PORT/gateway/verify | grep -qi 'x-request-id'"

# --------------------------------------------------------------- report
printf '\n'
if [[ $FAIL -eq 0 ]]; then
  printf '%s %d checks passed\n\n' "$(green '✓ platform ok:')" "$PASS"
  exit 0
fi

printf '%s %d passed, %d failed\n\n' "$(red '✗ platform not ok:')" "$PASS" "$FAIL"
for failure in "${FAILURES[@]}"; do
  printf '    %s\n' "$failure"
done
printf '\n'
exit 1
