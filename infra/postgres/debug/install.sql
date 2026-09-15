\set ON_ERROR_STOP on

ALTER ROLE horizon_debug PASSWORD :'debug_password';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'horizon_explain') THEN
    CREATE ROLE horizon_explain NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS horizon_debug AUTHORIZATION horizon_owner;
REVOKE ALL ON SCHEMA horizon_debug FROM PUBLIC;
GRANT USAGE ON SCHEMA horizon_debug TO horizon_debug, horizon_explain;
GRANT USAGE ON SCHEMA public TO horizon_explain;

-- Only this NOLOGIN role can read business tables, solely while executing the fixed
-- wrappers below. horizon_debug is deliberately not a member of it.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO horizon_explain;
ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO horizon_explain;

CREATE OR REPLACE FUNCTION horizon_debug.explain_query(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '10s'
AS $$
DECLARE
  sanitized text := regexp_replace(btrim(query_text), ';[[:space:]]*$', '');
  plan jsonb;
BEGIN
  IF length(sanitized) = 0 OR length(sanitized) > 10000 THEN
    RAISE EXCEPTION 'query must contain 1-10000 characters';
  END IF;
  IF sanitized !~* '^(select|with)[[:space:]]' OR sanitized ~ ';' OR
     sanitized ~ '--|/\*' OR
     sanitized ~* '(^|[^a-z_])(insert|update|delete|merge|copy|call|do|alter|create|drop|truncate|grant|revoke|set|reset|vacuum|analyze|refresh|reindex|cluster|lock)([^a-z_]|$)' OR
     sanitized ~* '(^|[^a-z_])(pg_sleep|set_config|nextval|currval|setval|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export)[[:space:]]*\(' OR
     sanitized ~* '[[:space:]]for[[:space:]]+(update|share|no[[:space:]]+key[[:space:]]+update|key[[:space:]]+share)' THEN
    RAISE EXCEPTION 'only one read-only SELECT is accepted';
  END IF;
  EXECUTE 'EXPLAIN (ANALYZE FALSE, FORMAT JSON) ' || sanitized INTO plan;
  RETURN plan;
END
$$;
ALTER FUNCTION horizon_debug.explain_query(text) OWNER TO horizon_explain;
REVOKE ALL ON FUNCTION horizon_debug.explain_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION horizon_debug.explain_query(text) TO horizon_debug;

CREATE OR REPLACE FUNCTION horizon_debug.describe_schema(target_schema text DEFAULT 'public')
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'schema', target_schema,
    'tables', coalesce(jsonb_agg(jsonb_build_object(
      'name', c.relname,
      'rowLevelSecurity', c.relrowsecurity,
      'columns', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'nullable', NOT a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid)
        ) ORDER BY a.attnum), '[]'::jsonb)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ),
      'indexes', (
        SELECT coalesce(jsonb_agg(pg_get_indexdef(i.indexrelid)), '[]'::jsonb)
        FROM pg_index i WHERE i.indrelid = c.oid
      ),
      'constraints', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('name', k.conname, 'definition', pg_get_constraintdef(k.oid))), '[]'::jsonb)
        FROM pg_constraint k WHERE k.conrelid = c.oid
      ),
      'policies', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('name', p.polname, 'command', p.polcmd)), '[]'::jsonb)
        FROM pg_policy p WHERE p.polrelid = c.oid
      )
    ) ORDER BY c.relname) FILTER (WHERE c.oid IS NOT NULL), '[]'::jsonb)
  )
  FROM pg_namespace n
  LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p')
  WHERE n.nspname = target_schema
$$;
ALTER FUNCTION horizon_debug.describe_schema(text) OWNER TO horizon_explain;
REVOKE ALL ON FUNCTION horizon_debug.describe_schema(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION horizon_debug.describe_schema(text) TO horizon_debug;

CREATE OR REPLACE FUNCTION horizon_debug.outbox_backlog()
RETURNS TABLE(pending bigint, oldest_age_seconds double precision)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF to_regclass('public.outbox') IS NULL THEN
    RETURN QUERY SELECT 0::bigint, NULL::double precision;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT count(*)::bigint, extract(epoch FROM (clock_timestamp() - min(created_at)))::double precision
       FROM public.outbox WHERE dispatched_at IS NULL';
END
$$;
ALTER FUNCTION horizon_debug.outbox_backlog() OWNER TO horizon_explain;
REVOKE ALL ON FUNCTION horizon_debug.outbox_backlog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION horizon_debug.outbox_backlog() TO horizon_debug;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM horizon_debug;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM horizon_debug;
ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public REVOKE ALL ON TABLES FROM horizon_debug;
ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM horizon_debug;
