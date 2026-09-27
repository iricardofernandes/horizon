#!/usr/bin/env bash
# Phase 53 restore check of the service, contract and billing data on the local stack.
#
# Dumps horizon_sales, restores it into a new PostgreSQL with the module's roles, and
# compares a digest of every service table for the tenant, live against restored. It then
# proves the restored database still guards the data: a billed period, a revision and a
# decided run item refuse a rewrite, and another tenant sees nothing.
#
#   scripts/phase53-restore-check.sh [tenant-uuid]
#
# The restored container is removed at the end.
set -euo pipefail

TENANT="${1:-01a0c5f8-798b-721e-912e-9b505406e614}"
RESTORED=horizon-phase53-restore-postgres
OTHER="$(cat /proc/sys/kernel/random/uuid)"
TABLES=(
  service_orders service_order_lines service_deliveries service_delivery_lines
  service_delivery_effects service_delivery_line_nfse
  service_contracts service_contract_revisions service_contract_revision_lines
  service_contract_suspensions
  contract_billed_periods contract_billed_period_lines
  contract_billing_runs contract_billing_run_items
)

docker rm -f "$RESTORED" >/dev/null 2>&1 || true
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"; docker rm -f "$RESTORED" >/dev/null 2>&1 || true' EXIT

echo "== dump horizon_sales"
docker exec horizon-postgres pg_dump -U postgres -d horizon_sales --format=custom >"$DUMP"
sha256sum "$DUMP" | cut -d' ' -f1 | sed 's/^/dump sha256 /'

echo "== restore into a new PostgreSQL"
docker run -d --name "$RESTORED" -e POSTGRES_PASSWORD=restore postgres:17-alpine >/dev/null
until docker exec "$RESTORED" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2
for statement in \
  "CREATE ROLE horizon_owner LOGIN PASSWORD 'horizon' NOSUPERUSER NOBYPASSRLS" \
  "CREATE ROLE horizon_app LOGIN PASSWORD 'horizon' NOSUPERUSER NOBYPASSRLS" \
  "CREATE ROLE horizon_relay LOGIN PASSWORD 'horizon' NOSUPERUSER NOBYPASSRLS" \
  "CREATE ROLE horizon_debug NOLOGIN NOSUPERUSER NOBYPASSRLS" \
  "CREATE ROLE horizon_explain NOLOGIN NOSUPERUSER NOBYPASSRLS" \
  "CREATE DATABASE horizon_sales OWNER horizon_owner"; do
  docker exec "$RESTORED" psql -U postgres -q -v ON_ERROR_STOP=1 -c "$statement"
done
# The live cluster's monitoring extension belongs to the cluster, not to Sales: it is left
# out of the restore list, and everything the module owns is restored as its owner.
docker cp "$DUMP" "$RESTORED:/tmp/sales.dump" >/dev/null
docker exec "$RESTORED" sh -c \
  "pg_restore -l /tmp/sales.dump | grep -v 'EXTENSION' > /tmp/sales.list"
docker exec "$RESTORED" pg_restore -U postgres -d horizon_sales --no-owner \
  --role=horizon_owner --exit-on-error -L /tmp/sales.list /tmp/sales.dump

live() { docker exec horizon-postgres psql -U postgres -d horizon_sales -At -c "$1"; }
restored() { docker exec "$RESTORED" psql -U postgres -d horizon_sales -At -c "$1"; }
digest_of() {
  echo "select count(*) || ' ' || coalesce(md5(string_agg(row_text, '|' order by row_text)), '-')
    from (select t::text as row_text from $1 t where tenant_id = '$TENANT') rows"
}

echo "== compare every service table for tenant $TENANT"
failures=0
for table in "${TABLES[@]}"; do
  expected="$(live "$(digest_of "$table")")"
  actual="$(restored "$(digest_of "$table")")"
  if [ "$expected" = "$actual" ]; then
    echo "ok    $table  $actual"
  else
    echo "DIFF  $table  live=$expected restored=$actual"
    failures=$((failures + 1))
  fi
done
[ "$failures" -eq 0 ] || { echo "$failures table(s) differ"; exit 1; }

echo "== the restored database still guards the data"
refused() {
  local label="$1" statement="$2" pattern="$3" output
  if output="$(docker exec "$RESTORED" psql -U postgres -d horizon_sales -v ON_ERROR_STOP=1 -c "$statement" 2>&1)"; then
    echo "FAIL  $label was accepted"
    exit 1
  fi
  grep -q "$pattern" <<<"$output" || { echo "FAIL  $label: $output"; exit 1; }
  echo "ok    $label refused"
}
refused "rewriting a billed period" \
  "update contract_billed_periods set value = value + 1 where tenant_id = '$TENANT'" \
  "never changes what it billed"
refused "rewriting a billed line" \
  "update contract_billed_period_lines set amount = amount + 1 where tenant_id = '$TENANT'" \
  "never changes what it billed"
refused "deciding a run item again" \
  "update contract_billing_run_items set outcome = 'skipped', reason = 'suspended', billed_period_id = null where tenant_id = '$TENANT' and outcome = 'billed'" \
  "decided once"
refused "rewriting a delivery" \
  "update service_deliveries set value = value + 1 where tenant_id = '$TENANT'" \
  "never rewritten"
app() {
  docker exec "$RESTORED" psql -U horizon_app -d horizon_sales -At -v ON_ERROR_STOP=1 \
    -c "begin; select set_config('app.current_tenant', '$1', true); $2; commit;" 2>&1
}
rewrite="$(app "$TENANT" "update service_contract_revision_lines set unit_price = 1" || true)"
if grep -q "permission denied" <<<"$rewrite"; then
  echo "ok    the application role cannot rewrite a revision"
else
  echo "FAIL  a revision line was writable"; exit 1
fi
seen="$(app "$OTHER" "select count(*) from contract_billed_periods" | sed -n 3p)"
[ "$seen" = "0" ] || { echo "FAIL  another tenant saw $seen billed periods"; exit 1; }
echo "ok    another tenant sees no billed period"
echo "restore check passed"
