-- Retention (ADR 0063, Phase 69): old inbox rows are removed by the retention job, as the
-- relay role, which may see only their tenant and age. Fiscal's idempotency tables guard
-- documents with legal effect and are never removed by retention.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'horizon_relay') THEN
    GRANT USAGE ON SCHEMA public TO horizon_relay;
    GRANT SELECT (tenant_id, received_at), DELETE ON inbox TO horizon_relay;
    CREATE POLICY relay_retention_read ON inbox FOR SELECT TO horizon_relay USING (true);
    CREATE POLICY relay_retention_delete ON inbox FOR DELETE TO horizon_relay USING (true);
  END IF;
END $$;
