CREATE TABLE cancellation_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  request_id uuid NOT NULL,
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT cancellation_document_key UNIQUE (tenant_id, document_id),
  CONSTRAINT cancellation_request_key UNIQUE (tenant_id, request_id),
  CONSTRAINT cancellation_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE cancellation_responses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('unknown', 'cancelled', 'rejected')),
  provider_reference text,
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_response_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES cancellation_attempts(tenant_id, id),
  CONSTRAINT cancellation_response_unique UNIQUE
    (tenant_id, attempt_id, outcome, response_digest)
);

ALTER TABLE cancellation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellation_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON cancellation_attempts TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE cancellation_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellation_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON cancellation_responses TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON cancellation_attempts, cancellation_responses TO horizon_app;
CREATE TRIGGER cancellation_attempts_immutable BEFORE UPDATE OR DELETE ON cancellation_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER cancellation_responses_immutable BEFORE UPDATE OR DELETE ON cancellation_responses
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
