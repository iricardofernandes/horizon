CREATE TABLE fiscal_calculations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  predecessor_id uuid,
  input_ciphertext bytea NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  resolved_rules jsonb NOT NULL CHECK (jsonb_typeof(resolved_rules) = 'object'),
  rules_digest text NOT NULL CHECK (rules_digest ~ '^[0-9a-f]{64}$'),
  result_bytes bytea NOT NULL CHECK (octet_length(result_bytes) > 0),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  explanation_template_version text NOT NULL,
  explanation_text text NOT NULL,
  rule_version_ids uuid[] NOT NULL,
  package_digests text[] NOT NULL,
  supported boolean NOT NULL CHECK (supported),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_calculation_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_calculation_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_calculation_predecessor_fk FOREIGN KEY (tenant_id, predecessor_id)
    REFERENCES fiscal_calculations(tenant_id, id),
  CONSTRAINT fiscal_calculation_successor_key UNIQUE (tenant_id, predecessor_id)
);

CREATE TABLE fiscal_document_calculation_bindings (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  calculation_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fiscal_calculation_binding_unique UNIQUE (tenant_id, calculation_id),
  CONSTRAINT fiscal_calculation_binding_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_calculation_binding_calculation_fk FOREIGN KEY (tenant_id, calculation_id)
    REFERENCES fiscal_calculations(tenant_id, id)
);

ALTER TABLE fiscal_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_calculations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_calculations TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_document_calculation_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_document_calculation_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_document_calculation_bindings TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_calculations, fiscal_document_calculation_bindings TO horizon_app;
CREATE TRIGGER fiscal_calculations_immutable BEFORE UPDATE OR DELETE ON fiscal_calculations
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_document_calculation_bindings_immutable
  BEFORE UPDATE OR DELETE ON fiscal_document_calculation_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();

-- Replace the Phase 40 status guard so validation and every later submission require
-- the immutable calculation binding introduced in this migration.
CREATE OR REPLACE FUNCTION guard_fiscal_document_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fiscal document is immutable'; END IF;
  IF to_jsonb(NEW) - 'status' <> to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION 'fiscal document facts are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'validated') OR
    (OLD.status = 'validated' AND NEW.status = 'submitted') OR
    (OLD.status = 'submitted' AND NEW.status IN ('unknown', 'authorized', 'rejected')) OR
    (OLD.status = 'unknown' AND NEW.status IN ('authorized', 'rejected')) OR
    (OLD.status = 'authorized' AND NEW.status = 'cancellation_pending') OR
    (OLD.status = 'cancellation_pending' AND NEW.status IN ('authorized', 'cancelled'))
  ) THEN RAISE EXCEPTION 'invalid fiscal document transition'; END IF;
  IF NEW.status IN ('validated', 'submitted', 'unknown', 'authorized', 'rejected',
      'cancellation_pending', 'cancelled') AND NOT EXISTS (
    SELECT 1 FROM fiscal_document_calculation_bindings binding
    WHERE binding.tenant_id = NEW.tenant_id AND binding.document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fiscal document requires a supported calculation';
  END IF;
  RETURN NEW;
END $$;
