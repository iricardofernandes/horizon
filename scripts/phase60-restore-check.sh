#!/usr/bin/env bash
# Phase 60 restore check of the CRM data on the local stack.
#
# Dumps horizon_crm, restores it into a new PostgreSQL with the module's roles, and compares
# a digest of every CRM table for the tenant, live against restored. It then proves the
# restored database still guards the data:
#   - the opportunity history and the note revisions refuse a rewrite;
#   - the history refuses a back-dated fact, so a settled cutoff stays settled;
#   - an erased contact key cannot come back;
#   - the relay role reads no record text;
#   - another tenant sees nothing.
#
#   scripts/phase60-restore-check.sh [tenant-uuid]
#
# The restored container is removed at the end.
set -euo pipefail

TENANT="${1:-01a0c5f8-798b-721e-912e-9b505406e614}"
RESTORED=horizon-phase60-restore-postgres
OTHER="$(cat /proc/sys/kernel/random/uuid)"
TABLES=(
  accounts contacts contact_data_keys owners
  pipelines pipeline_stages list_entries opportunities opportunity_events opportunity_quotes
  account_data_keys activities tasks notes note_revisions
  metric_states metric_stage_visits metric_closures
  audit_log
)

docker rm -f "$RESTORED" >/dev/null 2>&1 || true
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"; docker rm -f "$RESTORED" >/dev/null 2>&1 || true' EXIT

echo "== dump horizon_crm"
docker exec horizon-postgres pg_dump -U postgres -d horizon_crm --format=custom >"$DUMP"
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
  "CREATE DATABASE horizon_crm OWNER horizon_owner"; do
  docker exec "$RESTORED" psql -U postgres -q -v ON_ERROR_STOP=1 -c "$statement"
done
# The data is loaded before the triggers are created, so the history's instant check does
# not refuse the old facts it restores; it guards every insert after the restore.
docker cp "$DUMP" "$RESTORED:/tmp/crm.dump" >/dev/null
docker exec "$RESTORED" sh -c "pg_restore -l /tmp/crm.dump | grep -v 'EXTENSION' > /tmp/crm.list"
docker exec "$RESTORED" pg_restore -U postgres -d horizon_crm --no-owner \
  --role=horizon_owner --exit-on-error -L /tmp/crm.list /tmp/crm.dump

live() { docker exec horizon-postgres psql -U postgres -d horizon_crm -At -c "$1"; }
restored() { docker exec "$RESTORED" psql -U postgres -d horizon_crm -At -c "$1"; }
digest_of() {
  echo "select count(*) || ' ' || coalesce(md5(string_agg(row_text, '|' order by row_text)), '-')
    from (select t::text as row_text from $1 t where tenant_id = '$TENANT') rows"
}

echo "== compare every CRM table for tenant $TENANT"
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
  if output="$(docker exec "$RESTORED" psql -U postgres -d horizon_crm -v ON_ERROR_STOP=1 -c "$statement" 2>&1)"; then
    echo "FAIL  $label was accepted"
    exit 1
  fi
  grep -q "$pattern" <<<"$output" || { echo "FAIL  $label: $output"; exit 1; }
  echo "ok    $label refused"
}
refused "rewriting the opportunity history" \
  "update opportunity_events set actor = 'x' where tenant_id = '$TENANT'" \
  "append-only"
refused "a back-dated opportunity fact" \
  "insert into opportunity_events (tenant_id, opportunity_id, sequence, type, fact, actor, occurred_at)
     select tenant_id, opportunity_id, 999, 'revised', '{}'::jsonb, 'x', now() - interval '1 day'
     from opportunity_events where tenant_id = '$TENANT' limit 1" \
  "recorded at the instant it happens"
refused "rewriting a note revision" \
  "update note_revisions set author = 'x' where tenant_id = '$TENANT'" \
  "append-only"
erased_contact="$(restored "select id from contact_data_keys where tenant_id = '$TENANT' and material is null limit 1")"
if [ -n "$erased_contact" ]; then
  refused "restoring an erased contact key" \
    "update contact_data_keys set material = 'back', erased_at = null where id = '$erased_contact'" \
    "cannot be restored"
fi
relay() {
  docker exec "$RESTORED" psql -U horizon_relay -d horizon_crm -At -v ON_ERROR_STOP=1 -c "$1" 2>&1
}
if grep -q "permission denied" <<<"$(relay "select title_ciphertext from tasks limit 1" || true)"; then
  echo "ok    the relay role cannot read a task title"
else
  echo "FAIL  the relay role read a task title"; exit 1
fi
app() {
  docker exec "$RESTORED" psql -U horizon_app -d horizon_crm -At -v ON_ERROR_STOP=1 \
    -c "begin; select set_config('app.current_tenant', '$1', true); $2; commit;" 2>&1
}
seen="$(app "$OTHER" "select count(*) from opportunities" | sed -n 3p)"
[ "$seen" = "0" ] || { echo "FAIL  another tenant saw $seen opportunities"; exit 1; }
echo "ok    another tenant sees no opportunity"
own="$(app "$TENANT" "select count(*) from metric_states" | sed -n 3p)"
[ "${own:-0}" -gt 0 ] || { echo "FAIL  the tenant's metric rows are missing"; exit 1; }
echo "ok    the tenant reads its own metric rows ($own)"
echo "restore check passed"
