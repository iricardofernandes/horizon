#!/bin/bash
#
# One container, N databases (ADR 0016). In the Terraform definition this is one RDS
# instance per module; module code never sees the difference, because it holds a
# connection string and nothing else.
#
# Three roles, and the separation matters (ADR 0017):
#   horizon_owner  — owns the schema, runs migrations. The application never uses it.
#   horizon_app    — what the services connect as. NOSUPERUSER, NOBYPASSRLS, so
#                    Row-Level Security actually applies to it.
#   horizon_debug  — the MCP debugger. No privileges on business tables at all
#                    (ADR 0035); it reads pg_catalog and pg_stat_statements.

set -euo pipefail

MODULES=(identity catalog inventory sales webhooks)

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
  CREATE ROLE horizon_owner LOGIN PASSWORD '${HORIZON_OWNER_PASSWORD:-horizon}'
    NOSUPERUSER NOCREATEROLE NOBYPASSRLS;

  CREATE ROLE horizon_app LOGIN PASSWORD '${HORIZON_APP_PASSWORD:-horizon}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

  CREATE ROLE horizon_debug LOGIN PASSWORD '${HORIZON_DEBUG_PASSWORD:-horizon}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

  -- Statistics access, not data access. Without this pg_stat_statements shows the
  -- debug role only its own statements, which are none.
  GRANT pg_read_all_stats TO horizon_debug;
SQL

for module in "${MODULES[@]}"; do
  echo "creating database horizon_${module}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
    CREATE DATABASE horizon_${module} OWNER horizon_owner;
SQL

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "horizon_${module}" <<-SQL
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

    -- The application role may use the schema but may not create in it: DDL belongs to
    -- migrations, which run as horizon_owner.
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO horizon_app;
    GRANT USAGE ON SCHEMA public TO horizon_debug;

    -- Whatever the owner creates later, the application role can read and write —
    -- subject to RLS, which it cannot bypass.
    ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO horizon_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO horizon_app;
SQL
done

echo "postgres init complete: ${#MODULES[@]} databases, 3 roles"
