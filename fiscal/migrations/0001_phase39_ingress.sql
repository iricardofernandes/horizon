CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbox (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_module, event_id)
);

CREATE TABLE fiscal_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  origin_module text NOT NULL,
  origin_document_type text NOT NULL,
  origin_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('original', 'return')),
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  payload_digest text NOT NULL,
  status text NOT NULL DEFAULT 'blocked_profile' CHECK (status = 'blocked_profile'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_intents_origin_key UNIQUE (
    tenant_id, origin_module, origin_document_type, origin_id, purpose
  )
);

CREATE TABLE profile_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL CHECK (source_module IN ('parties', 'identity')),
  subject_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  effective_from date NOT NULL,
  noticed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_requests_key UNIQUE (tenant_id, source_module, subject_id, revision)
);

-- A subject key is destroyed when the owner publishes erasure. The retained encrypted
-- bytes then become unreadable without mutating immutable document evidence.
CREATE TABLE profile_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL CHECK (source_module IN ('parties', 'identity')),
  subject_id uuid NOT NULL,
  material text,
  erased_at timestamptz,
  PRIMARY KEY (tenant_id, source_module, subject_id)
);

CREATE TABLE profile_revisions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL CHECK (source_module IN ('parties', 'identity')),
  subject_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  effective_from date NOT NULL,
  ciphertext text NOT NULL,
  digest text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_revisions_key UNIQUE (tenant_id, source_module, subject_id, revision),
  CONSTRAINT profile_revisions_subject_key FOREIGN KEY (tenant_id, source_module, subject_id)
    REFERENCES profile_keys(tenant_id, source_module, subject_id)
);

CREATE TABLE catalog_classifications (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  effective_from date NOT NULL,
  ncm text CHECK (ncm ~ '^\d{8}$'),
  CONSTRAINT catalog_classifications_key UNIQUE (tenant_id, item_id, revision)
);

CREATE TABLE backfill_checkpoints (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL CHECK (source_module IN ('parties', 'identity', 'catalog')),
  cursor text,
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  digest text NOT NULL DEFAULT '',
  completed_at timestamptz,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_module)
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app
  USING (id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (id = current_setting('app.current_tenant')::uuid);

ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inbox TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE fiscal_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_intents TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE profile_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON profile_requests TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE profile_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON profile_keys TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON profile_revisions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE catalog_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_classifications TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

ALTER TABLE backfill_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE backfill_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON backfill_checkpoints TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

REVOKE ALL ON tenants, inbox, fiscal_intents, profile_requests, profile_keys,
  profile_revisions, catalog_classifications, backfill_checkpoints FROM horizon_app;
GRANT SELECT, INSERT ON tenants, inbox, fiscal_intents, profile_requests,
  profile_revisions, catalog_classifications TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON profile_keys, backfill_checkpoints TO horizon_app;

CREATE FUNCTION reject_fiscal_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fiscal history is append-only'; END $$;
CREATE TRIGGER fiscal_intents_immutable BEFORE UPDATE OR DELETE ON fiscal_intents
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER profile_revisions_immutable BEFORE UPDATE OR DELETE ON profile_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER catalog_classifications_immutable BEFORE UPDATE OR DELETE ON catalog_classifications
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
