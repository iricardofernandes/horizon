ALTER TABLE fiscal_documents DROP CONSTRAINT fiscal_documents_status_check;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_status_check CHECK (
  status IN ('draft', 'validated', 'submitted', 'unknown', 'authorized', 'rejected',
    'cancellation_pending', 'cancelled')
);

CREATE FUNCTION guard_fiscal_document_status() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END $$;
DROP TRIGGER fiscal_documents_immutable ON fiscal_documents;
CREATE TRIGGER fiscal_documents_status_guard BEFORE UPDATE OR DELETE ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_document_status();
GRANT UPDATE (status) ON fiscal_documents TO horizon_app;

ALTER TABLE fiscal_transitions DROP CONSTRAINT fiscal_transitions_kind_check;
ALTER TABLE fiscal_transitions ADD CONSTRAINT fiscal_transitions_kind_check CHECK (
  kind IN ('draft_created', 'number_reserved', 'validated', 'submitted', 'unknown',
    'authorized', 'rejected', 'cancellation_pending', 'cancelled')
);

CREATE TABLE authority_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  request_id uuid NOT NULL,
  number bigint NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authority_attempt_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT authority_attempt_document_key UNIQUE (tenant_id, document_id),
  CONSTRAINT authority_attempt_request_key UNIQUE (tenant_id, request_id)
);
ALTER TABLE authority_attempts ADD CONSTRAINT authority_attempt_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE authority_responses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('unknown', 'authorized', 'rejected')),
  provider_reference text,
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authority_response_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES authority_attempts(tenant_id, id),
  CONSTRAINT authority_response_unique UNIQUE (tenant_id, attempt_id, outcome, response_digest)
);

CREATE TABLE fiscal_outbox (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id, event_id)
);

ALTER TABLE authority_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON authority_attempts TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE authority_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON authority_responses TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_outbox TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON authority_attempts, authority_responses, fiscal_outbox TO horizon_app;
CREATE TRIGGER authority_attempts_immutable BEFORE UPDATE OR DELETE ON authority_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER authority_responses_immutable BEFORE UPDATE OR DELETE ON authority_responses
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
