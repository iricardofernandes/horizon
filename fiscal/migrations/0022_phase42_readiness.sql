-- Public readiness derives fiscal facts from immutable owner projections. This binding
-- freezes the exact selection; callers cannot supply or later rewrite calculation facts.
CREATE TABLE fiscal_document_readiness_bindings (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  issuer_profile_revision integer NOT NULL CHECK (issuer_profile_revision > 0),
  recipient_party_id uuid NOT NULL,
  recipient_profile_revision integer NOT NULL CHECK (recipient_profile_revision > 0),
  classification_revisions jsonb NOT NULL,
  origin_digest text NOT NULL CHECK (origin_digest ~ '^[0-9a-f]{64}$'),
  reconciliation_digest text NOT NULL CHECK (reconciliation_digest ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fiscal_readiness_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_readiness_capability_fk FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id),
  CONSTRAINT fiscal_readiness_classification_revisions_object CHECK (
    jsonb_typeof(classification_revisions) = 'object'
  )
);

ALTER TABLE fiscal_document_readiness_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_document_readiness_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_document_readiness_bindings TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_document_readiness_bindings TO horizon_app;
CREATE TRIGGER fiscal_document_readiness_bindings_immutable
  BEFORE UPDATE OR DELETE ON fiscal_document_readiness_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();

-- The binding is inserted before draft -> ready inside the readiness calculation
-- transaction. Phase 41's internal lock path remains available for historical replay;
-- only the Phase 42 public command requires this evidence.
