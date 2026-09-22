-- Phase 42 persistence foundation. Existing Phase 40/41 commands continue to work while
-- the ready/queued worker is introduced in a later forward migration. Nothing here
-- activates an authority capability or submits a document.

CREATE TABLE fiscal_manual_origins (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  establishment_id uuid NOT NULL,
  issuer_profile_revision integer NOT NULL CHECK (issuer_profile_revision > 0),
  recipient_party_id uuid NOT NULL,
  recipient_profile_revision integer NOT NULL CHECK (recipient_profile_revision > 0),
  issue_date date NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_manual_origin_tenant_id_key UNIQUE (tenant_id, id)
);

-- Backfill historic rows without rewriting their origin, number or calculation.
ALTER TABLE fiscal_documents ADD COLUMN root_document_id uuid;
ALTER TABLE fiscal_documents ADD COLUMN predecessor_document_id uuid;
ALTER TABLE fiscal_documents ADD COLUMN revision integer NOT NULL DEFAULT 1
  CHECK (revision > 0);
ALTER TABLE fiscal_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_documents DISABLE TRIGGER fiscal_documents_status_guard;
UPDATE fiscal_documents SET root_document_id = id WHERE root_document_id IS NULL;
ALTER TABLE fiscal_documents ENABLE TRIGGER fiscal_documents_status_guard;
ALTER TABLE fiscal_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_documents ALTER COLUMN root_document_id SET NOT NULL;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_root_fk
  FOREIGN KEY (tenant_id, root_document_id) REFERENCES fiscal_documents(tenant_id, id);
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_predecessor_fk
  FOREIGN KEY (tenant_id, predecessor_document_id) REFERENCES fiscal_documents(tenant_id, id);
CREATE UNIQUE INDEX fiscal_document_revision_key
  ON fiscal_documents (tenant_id, root_document_id, revision);
CREATE UNIQUE INDEX fiscal_document_successor_key
  ON fiscal_documents (tenant_id, predecessor_document_id)
  WHERE predecessor_document_id IS NOT NULL;

CREATE FUNCTION set_fiscal_document_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_document_id IS NULL THEN NEW.root_document_id := NEW.id; END IF;
  IF NEW.predecessor_document_id IS NULL AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'root Fiscal document must have revision 1' USING ERRCODE = '23514';
  END IF;
  IF NEW.predecessor_document_id IS NOT NULL AND NEW.revision = 1 THEN
    RAISE EXCEPTION 'successor Fiscal document must advance revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_document_root_before_insert BEFORE INSERT ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION set_fiscal_document_root();

-- Command facts and worker leases are separate: a worker may update a lease but cannot
-- rewrite the signed request identity or its digest.
CREATE TABLE fiscal_dispatch_commands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issuance', 'status_query', 'cancellation', 'cancellation_query')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_dispatch_command_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_dispatch_command_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_dispatch_command_idempotency_key UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE fiscal_dispatch_jobs (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done')),
  lease_owner text,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, command_id),
  CONSTRAINT fiscal_dispatch_job_command_fk FOREIGN KEY (tenant_id, command_id)
    REFERENCES fiscal_dispatch_commands(tenant_id, id),
  CONSTRAINT fiscal_dispatch_job_lease_check CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR
    (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX fiscal_dispatch_jobs_due ON fiscal_dispatch_jobs
  (next_attempt_at, tenant_id, command_id) WHERE state = 'pending';

CREATE TABLE fiscal_dispatch_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  observation_kind text NOT NULL CHECK (observation_kind IN ('response', 'callback', 'consultation')),
  outcome text NOT NULL CHECK (outcome IN ('authorized', 'rejected', 'cancelled', 'unknown')),
  provider_correlation text CHECK (length(provider_correlation) BETWEEN 1 AND 256),
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  protocol_digest text CHECK (protocol_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_dispatch_observation_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_dispatch_observation_command_fk FOREIGN KEY (tenant_id, command_id)
    REFERENCES fiscal_dispatch_commands(tenant_id, id),
  CONSTRAINT fiscal_dispatch_observation_identity UNIQUE
    (tenant_id, command_id, observation_kind, response_digest)
);
CREATE UNIQUE INDEX fiscal_dispatch_final_observation_once
  ON fiscal_dispatch_observations (tenant_id, command_id)
  WHERE outcome IN ('authorized', 'rejected', 'cancelled');

CREATE TABLE fiscal_dispatch_inbox (
  tenant_id uuid NOT NULL,
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 256),
  observation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_message_id),
  CONSTRAINT fiscal_dispatch_inbox_observation_fk FOREIGN KEY (tenant_id, observation_id)
    REFERENCES fiscal_dispatch_observations(tenant_id, id)
);

ALTER TABLE fiscal_artifacts ADD COLUMN purpose text CHECK (purpose IN (
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe'
));
ALTER TABLE fiscal_artifacts ADD COLUMN command_id uuid;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifact_command_fk
  FOREIGN KEY (tenant_id, command_id) REFERENCES fiscal_dispatch_commands(tenant_id, id);
CREATE UNIQUE INDEX fiscal_artifact_command_purpose_digest_key
  ON fiscal_artifacts (tenant_id, command_id, purpose, digest)
  WHERE command_id IS NOT NULL;

ALTER TABLE fiscal_manual_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_manual_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_manual_origins TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_dispatch_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_dispatch_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_dispatch_commands TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_dispatch_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_dispatch_jobs TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_dispatch_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_dispatch_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_dispatch_observations TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_dispatch_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_dispatch_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_dispatch_inbox TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_manual_origins, fiscal_dispatch_commands,
  fiscal_dispatch_observations, fiscal_dispatch_inbox TO horizon_app;
GRANT SELECT, INSERT, UPDATE (state, lease_owner, lease_until, attempt_count,
  next_attempt_at, updated_at) ON fiscal_dispatch_jobs TO horizon_app;
CREATE TRIGGER fiscal_manual_origins_immutable BEFORE UPDATE OR DELETE ON fiscal_manual_origins
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_dispatch_commands_immutable BEFORE UPDATE OR DELETE ON fiscal_dispatch_commands
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_dispatch_observations_immutable BEFORE UPDATE OR DELETE ON fiscal_dispatch_observations
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_dispatch_inbox_immutable BEFORE UPDATE OR DELETE ON fiscal_dispatch_inbox
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
