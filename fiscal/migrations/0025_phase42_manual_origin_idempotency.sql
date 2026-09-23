CREATE TABLE fiscal_manual_origin_idempotency (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  origin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT fiscal_manual_origin_idempotency_origin_fk
    FOREIGN KEY (tenant_id, origin_id) REFERENCES fiscal_manual_origins(tenant_id, id)
);
ALTER TABLE fiscal_manual_origin_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_manual_origin_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_manual_origin_idempotency TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_manual_origin_idempotency TO horizon_app;
CREATE TRIGGER fiscal_manual_origin_idempotency_immutable
  BEFORE UPDATE OR DELETE ON fiscal_manual_origin_idempotency
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
