-- Phase 42 state vocabulary and durable queue guards. Historic `validated` rows are
-- calculation-locked documents, so the rename to `ready` does not weaken an invariant.
ALTER TABLE fiscal_documents DROP CONSTRAINT fiscal_documents_status_check;
ALTER TABLE fiscal_documents DISABLE TRIGGER fiscal_documents_status_guard;
UPDATE fiscal_documents SET status = 'ready' WHERE status = 'validated';
ALTER TABLE fiscal_documents ENABLE TRIGGER fiscal_documents_status_guard;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_status_check CHECK (
  status IN ('draft', 'ready', 'queued', 'submitted', 'unknown', 'authorized', 'rejected',
    'cancellation_pending', 'cancellation_unknown', 'cancelled')
);

ALTER TABLE fiscal_transitions DROP CONSTRAINT fiscal_transitions_kind_check;
ALTER TABLE fiscal_transitions DISABLE TRIGGER fiscal_transitions_immutable;
UPDATE fiscal_transitions SET kind = 'ready' WHERE kind = 'validated';
ALTER TABLE fiscal_transitions ENABLE TRIGGER fiscal_transitions_immutable;
ALTER TABLE fiscal_transitions ADD CONSTRAINT fiscal_transitions_kind_check CHECK (
  kind IN ('draft_created', 'number_reserved', 'ready', 'queued', 'submitted', 'unknown',
    'authorized', 'rejected', 'cancellation_pending', 'cancellation_unknown', 'cancelled')
);

-- A Sales origin can have historical rejected revisions, but only one live revision.
ALTER TABLE fiscal_documents DROP CONSTRAINT fiscal_documents_intent_key;
CREATE UNIQUE INDEX fiscal_document_active_sales_origin_key
  ON fiscal_documents (tenant_id, intent_id)
  WHERE intent_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');

-- Manual simulation origins are first-class origins, never caller-supplied XML shortcuts.
ALTER TABLE fiscal_documents ADD COLUMN manual_origin_id uuid;
ALTER TABLE fiscal_documents ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_manual_origin_fk
  FOREIGN KEY (tenant_id, manual_origin_id) REFERENCES fiscal_manual_origins(tenant_id, id);
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_origin_exactly_one CHECK (
  (intent_id IS NOT NULL AND manual_origin_id IS NULL) OR
  (intent_id IS NULL AND manual_origin_id IS NOT NULL)
);
CREATE UNIQUE INDEX fiscal_document_active_manual_origin_key
  ON fiscal_documents (tenant_id, manual_origin_id)
  WHERE manual_origin_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');

-- Access keys and signed bytes are immutable issuance facts. Keeping them in a binding
-- table avoids relaxing document immutability while the XML pipeline is added in 42.4.
CREATE TABLE fiscal_document_issuance_bindings (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  access_key text NOT NULL CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
  reconciliation_digest text NOT NULL CHECK (reconciliation_digest ~ '^[0-9a-f]{64}$'),
  signed_xml_digest text NOT NULL CHECK (signed_xml_digest ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fiscal_issuance_binding_access_key UNIQUE (tenant_id, environment, access_key),
  CONSTRAINT fiscal_issuance_binding_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_issuance_binding_capability_fk FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id)
);
ALTER TABLE fiscal_document_issuance_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_document_issuance_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_document_issuance_bindings TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_document_issuance_bindings TO horizon_app;
CREATE TRIGGER fiscal_document_issuance_bindings_immutable
  BEFORE UPDATE OR DELETE ON fiscal_document_issuance_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();

CREATE OR REPLACE FUNCTION guard_fiscal_document_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fiscal document is immutable'; END IF;
  IF to_jsonb(NEW) - 'status' <> to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION 'fiscal document facts are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'ready') OR
    (OLD.status = 'ready' AND NEW.status = 'queued') OR
    (OLD.status = 'queued' AND NEW.status = 'submitted') OR
    (OLD.status = 'submitted' AND NEW.status IN ('unknown', 'authorized', 'rejected')) OR
    (OLD.status = 'unknown' AND NEW.status IN ('authorized', 'rejected')) OR
    (OLD.status = 'authorized' AND NEW.status = 'cancellation_pending') OR
    (OLD.status = 'cancellation_pending' AND
      NEW.status IN ('authorized', 'cancelled', 'cancellation_unknown')) OR
    (OLD.status = 'cancellation_unknown' AND NEW.status IN ('authorized', 'cancelled'))
  ) THEN RAISE EXCEPTION 'invalid fiscal document transition'; END IF;
  IF NEW.status <> 'draft' AND NOT EXISTS (
    SELECT 1 FROM fiscal_document_calculation_bindings binding
    WHERE binding.tenant_id = NEW.tenant_id AND binding.document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fiscal document requires a supported calculation';
  END IF;
  IF NEW.status IN ('queued', 'submitted', 'unknown', 'authorized', 'rejected',
      'cancellation_pending', 'cancellation_unknown', 'cancelled') AND NOT EXISTS (
    SELECT 1 FROM fiscal_number_reservations reservation
    WHERE reservation.tenant_id = NEW.tenant_id AND reservation.document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fiscal document requires a reserved number';
  END IF;
  RETURN NEW;
END $$;

-- Leases may be reclaimed after expiry without first rewriting business evidence.
DROP INDEX fiscal_dispatch_jobs_due;
CREATE INDEX fiscal_dispatch_jobs_due ON fiscal_dispatch_jobs
  (next_attempt_at, tenant_id, command_id)
  WHERE state IN ('pending', 'leased');
