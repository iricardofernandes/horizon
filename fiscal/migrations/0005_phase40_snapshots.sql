ALTER TABLE fiscal_documents ADD COLUMN snapshot_ciphertext bytea;

CREATE TABLE fiscal_document_lines (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  line_index integer NOT NULL CHECK (line_index >= 0),
  item_id uuid,
  line_digest text NOT NULL CHECK (line_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, document_id, line_index),
  CONSTRAINT fiscal_line_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id)
);

CREATE TABLE fiscal_idempotency (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL CHECK (length(key) BETWEEN 16 AND 128),
  command text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  document_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  CONSTRAINT fiscal_idempotency_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id)
);

ALTER TABLE fiscal_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_document_lines TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_idempotency TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_document_lines, fiscal_idempotency TO horizon_app;
CREATE TRIGGER fiscal_document_lines_immutable BEFORE UPDATE OR DELETE ON fiscal_document_lines
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_idempotency_immutable BEFORE UPDATE OR DELETE ON fiscal_idempotency
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
