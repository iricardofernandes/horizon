CREATE TABLE fiscal_artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('xml', 'response', 'protocol', 'pdf')),
  object_key text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),
  media_type text NOT NULL,
  source_schema text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_artifact_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_artifact_identity_key UNIQUE (tenant_id, document_id, kind, digest),
  CONSTRAINT fiscal_artifact_object_key UNIQUE (object_key)
);

ALTER TABLE fiscal_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_artifacts TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_artifacts TO horizon_app;
CREATE TRIGGER fiscal_artifacts_immutable BEFORE UPDATE OR DELETE ON fiscal_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
