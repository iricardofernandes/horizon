-- Phase 40 starts with durable, tenant-owned drafts and irreversible number reservations.
-- No authority transmission or tax calculation is enabled by this migration.
ALTER TABLE fiscal_intents ADD CONSTRAINT fiscal_intents_tenant_id_key UNIQUE (tenant_id, id);

CREATE TABLE fiscal_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  intent_id uuid NOT NULL,
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  establishment_id uuid NOT NULL,
  series integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  -- Raw commercial/identity facts are not written until encrypted snapshots exist.
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_documents_intent_key UNIQUE (tenant_id, intent_id),
  CONSTRAINT fiscal_documents_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_documents_intent_fk FOREIGN KEY (tenant_id, intent_id)
    REFERENCES fiscal_intents(tenant_id, id)
);

CREATE TABLE fiscal_number_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  establishment_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  series integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  last_number bigint NOT NULL CHECK (last_number BETWEEN 1 AND 999999999),
  PRIMARY KEY (tenant_id, establishment_id, environment, model, series)
);

CREATE TABLE fiscal_number_reservations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  establishment_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  series integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  number bigint NOT NULL CHECK (number BETWEEN 1 AND 999999999),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fiscal_number_unique UNIQUE
    (tenant_id, establishment_id, environment, model, series, number),
  CONSTRAINT fiscal_number_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id)
);

CREATE TABLE fiscal_transitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('draft_created', 'number_reserved')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_transition_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id)
);

ALTER TABLE fiscal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_documents TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_number_counters TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_number_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_number_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_number_reservations TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_transitions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_documents, fiscal_number_reservations, fiscal_transitions TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON fiscal_number_counters TO horizon_app;
CREATE TRIGGER fiscal_documents_immutable BEFORE UPDATE OR DELETE ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_number_reservations_immutable BEFORE UPDATE OR DELETE ON fiscal_number_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_transitions_immutable BEFORE UPDATE OR DELETE ON fiscal_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
