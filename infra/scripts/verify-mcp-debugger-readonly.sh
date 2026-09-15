#!/usr/bin/env bash
set -euo pipefail

debug_password="${HORIZON_DEBUG_PASSWORD:-horizon}"
debug_psql=(docker exec -e "PGPASSWORD=${debug_password}" horizon-postgres psql -X --host 127.0.0.1 --username horizon_debug --dbname horizon_sales)

expect_failure() {
  local description="$1"
  shift
  if "${debug_psql[@]}" --command "$*" >/dev/null 2>&1; then
    echo "FAIL: ${description} unexpectedly succeeded" >&2
    exit 1
  fi
  echo "ok: ${description} denied"
}

expect_failure "business-table read" "SELECT * FROM public.tenants LIMIT 1"
expect_failure "business-table write" "INSERT INTO public.tenants (id, created_at) VALUES ('00000000-0000-0000-0000-000000000001', now())"
expect_failure "arbitrary SQL through explain wrapper" "SELECT horizon_debug.explain_query('SELECT pg_sleep(1)')"

"${debug_psql[@]}" --tuples-only --command "SELECT horizon_debug.describe_schema('public') IS NOT NULL" | grep -q t
"${debug_psql[@]}" --tuples-only --command "SELECT horizon_debug.explain_query('SELECT count(*) FROM public.sales_orders') IS NOT NULL" | grep -q t
"${debug_psql[@]}" --tuples-only --command "SELECT pending >= 0 FROM horizon_debug.outbox_backlog()" | grep -q t

echo "MCP debugger database role is read-only and its three wrappers are reachable"
