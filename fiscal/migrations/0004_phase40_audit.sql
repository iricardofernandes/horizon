CREATE TABLE fiscal_audit_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  hash text NOT NULL DEFAULT repeat('0', 64) CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE fiscal_audit_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_id uuid NOT NULL,
  detail_digest text NOT NULL CHECK (detail_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, sequence),
  UNIQUE (tenant_id, id)
);

ALTER TABLE fiscal_audit_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_audit_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_audit_heads TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_audit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_audit_entries TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT, UPDATE ON fiscal_audit_heads TO horizon_app;
GRANT SELECT, INSERT ON fiscal_audit_entries TO horizon_app;
CREATE TRIGGER fiscal_audit_entries_immutable BEFORE UPDATE OR DELETE ON fiscal_audit_entries
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
