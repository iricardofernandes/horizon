#!/usr/bin/env bash
set -euo pipefail

modules=(identity catalog inventory sales webhooks)
sql_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/postgres/debug/install.sql"
debug_password="${HORIZON_DEBUG_PASSWORD:-horizon}"

for module in "${modules[@]}"; do
  echo "installing MCP debugger wrappers in horizon_${module}"
  docker exec -i horizon-postgres psql --username postgres --dbname "horizon_${module}" \
    --set "debug_password=${debug_password}" < "$sql_file"
done
