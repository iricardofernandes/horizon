-- Retention (ADR 0063, Phase 69): delivery bookkeeping past its declared age is removed by
-- the retention job, as the relay role. It may see only the tenant and the age of a row.
GRANT USAGE ON SCHEMA public TO horizon_relay;
GRANT SELECT ("tenant_id", "created_at"), DELETE ON "command_receipts" TO horizon_relay;
CREATE POLICY relay_retention_read ON "command_receipts" FOR SELECT TO horizon_relay USING (true);
CREATE POLICY relay_retention_delete ON "command_receipts" FOR DELETE TO horizon_relay USING (true);
