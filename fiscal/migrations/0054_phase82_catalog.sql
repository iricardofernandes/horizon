-- Phase 82 (ADR 0070): tax law as a catalogue shared by every workspace. Catalogue tables have
-- no tenant, the application may only read them, and publishing uses the migration role.

CREATE TABLE fiscal_catalog_packages (
  id uuid PRIMARY KEY,
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 200),
  source_uri text NOT NULL CHECK (length(source_uri) BETWEEN 1 AND 1000),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  published_at date NOT NULL,
  effective_from date NOT NULL,
  source_bytes bytea NOT NULL,
  artifact_digest text CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[0-9a-f]{64}$'),
  artifact_byte_size bigint CHECK (artifact_byte_size IS NULL OR artifact_byte_size > 0),
  publisher text NOT NULL CHECK (length(publisher) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_catalog_package_key UNIQUE (authority, package_digest)
);

CREATE TABLE fiscal_catalog_references (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES fiscal_catalog_packages(id),
  family text NOT NULL CHECK (family IN ('cfop', 'ncm', 'cest', 'cst', 'csosn', 'ibs_cbs', 'service')),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  model text NOT NULL DEFAULT '*' CHECK (model IN ('*', '55', '65', 'nfse')),
  jurisdiction text NOT NULL DEFAULT '*' CHECK (length(jurisdiction) BETWEEN 1 AND 20),
  effective_from date NOT NULL,
  effective_to date,
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 300),
  row_digest text NOT NULL CHECK (row_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_catalog_reference_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fiscal_catalog_reference_key UNIQUE (
    package_id, family, code, model, jurisdiction, effective_from
  )
);

-- The same columns as a workspace's rules, without the tenant, and never scoped to one of a
-- workspace's establishments, parties or items: those are the workspace's own facts.
CREATE TABLE fiscal_catalog_rules (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES fiscal_catalog_packages(id),
  rule_key text NOT NULL CHECK (length(rule_key) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  component_group text NOT NULL CHECK (component_group IN ('legacy', 'ibs_cbs')),
  component_code text NOT NULL CHECK (component_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  precedence text NOT NULL CHECK (precedence IN ('operation', 'default')),
  priority integer NOT NULL CHECK (priority >= 0),
  date_basis text NOT NULL DEFAULT 'issue_date' CHECK (date_basis IN ('issue_date', 'competence_date')),
  purpose text NOT NULL DEFAULT 'normal' CHECK (purpose IN ('normal', 'return', 'complementary', 'adjustment')),
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  operation text NOT NULL DEFAULT '*',
  issuer_establishment_id text NOT NULL DEFAULT '*' CHECK (issuer_establishment_id = '*'),
  issuer_regime text NOT NULL DEFAULT '*',
  recipient_party_id text NOT NULL DEFAULT '*' CHECK (recipient_party_id = '*'),
  recipient_regime text NOT NULL DEFAULT '*',
  origin_state text NOT NULL DEFAULT '*',
  destination_state text NOT NULL DEFAULT '*',
  subject_kind text NOT NULL DEFAULT '*' CHECK (subject_kind = '*'),
  subject_id text NOT NULL DEFAULT '*' CHECK (subject_id = '*'),
  classification_kind text NOT NULL DEFAULT '*' CHECK (
    classification_kind IN ('*', 'ncm', 'cest', 'service', 'origin')
  ),
  classification_code text NOT NULL DEFAULT '*',
  effective_from date NOT NULL,
  effective_to date,
  rate_numerator text NOT NULL CHECK (rate_numerator ~ '^-?\d+$'),
  rate_denominator text NOT NULL CHECK (rate_denominator ~ '^[1-9]\d*$'),
  formula text NOT NULL CHECK (
    formula IN ('LINE_NET_TIMES_RATE', 'DOCUMENT_NET_TIMES_RATE', 'RETURN_LINE_NET_TIMES_RATE')
  ),
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 300),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_catalog_rule_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fiscal_catalog_rule_operation_scope CHECK (precedence <> 'operation' OR operation <> '*'),
  CONSTRAINT fiscal_catalog_rule_version_key UNIQUE (rule_key, version)
);

-- Equal-priority catalogue rules with the same scope may never overlap, as in a workspace.
CREATE FUNCTION reject_overlapping_fiscal_catalog_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'catalog:' || NEW.component_group || ':' || NEW.component_code || ':' || NEW.precedence || ':' ||
    NEW.priority::text || ':' || NEW.model || ':' || NEW.environment || ':' || NEW.purpose || ':' ||
    NEW.operation || ':' || NEW.issuer_regime || ':' || NEW.recipient_regime || ':' ||
    NEW.origin_state || ':' || NEW.destination_state || ':' || NEW.classification_kind || ':' ||
    NEW.classification_code,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_catalog_rules existing
    WHERE existing.component_group = NEW.component_group
      AND existing.component_code = NEW.component_code
      AND existing.precedence = NEW.precedence
      AND existing.priority = NEW.priority
      AND existing.model = NEW.model
      AND existing.environment = NEW.environment
      AND existing.purpose = NEW.purpose
      AND existing.operation = NEW.operation
      AND existing.issuer_regime = NEW.issuer_regime
      AND existing.recipient_regime = NEW.recipient_regime
      AND existing.origin_state = NEW.origin_state
      AND existing.destination_state = NEW.destination_state
      AND existing.classification_kind = NEW.classification_kind
      AND existing.classification_code = NEW.classification_code
      AND daterange(existing.effective_from, existing.effective_to, '[)') &&
          daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping equal-priority fiscal catalogue rule' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_catalog_rules_no_overlap BEFORE INSERT ON fiscal_catalog_rules
  FOR EACH ROW EXECUTE FUNCTION reject_overlapping_fiscal_catalog_rule();

-- A workspace adopts a package version, or withdraws it; the latest event decides.
CREATE TABLE fiscal_package_adoptions (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  package_id uuid NOT NULL REFERENCES fiscal_catalog_packages(id),
  action text NOT NULL CHECK (action IN ('adopt', 'withdraw')),
  effective_from date,
  reviewed_by text CHECK (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 200),
  interpretation text CHECK (interpretation IS NULL OR length(interpretation) BETWEEN 1 AND 4000),
  fixture_ids text[] NOT NULL DEFAULT '{}',
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_package_adoption_fields CHECK (
    (action = 'adopt' AND effective_from IS NOT NULL AND reviewed_by IS NOT NULL AND interpretation IS NOT NULL)
    OR (action = 'withdraw' AND effective_from IS NULL)
  ),
  CONSTRAINT fiscal_package_adoption_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX fiscal_package_adoptions_latest ON fiscal_package_adoptions (tenant_id, package_id, sequence DESC);

CREATE FUNCTION validate_fiscal_package_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_action text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':adopt:' || NEW.package_id::text, 0));
  SELECT action INTO latest_action FROM fiscal_package_adoptions
  WHERE tenant_id = NEW.tenant_id AND package_id = NEW.package_id
  ORDER BY sequence DESC LIMIT 1;
  IF NEW.action = 'adopt' AND latest_action = 'adopt' THEN
    RAISE EXCEPTION 'fiscal package is already adopted' USING ERRCODE = '23505';
  END IF;
  IF NEW.action = 'withdraw' AND latest_action IS DISTINCT FROM 'adopt' THEN
    RAISE EXCEPTION 'fiscal package is not adopted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_package_adoption_valid BEFORE INSERT ON fiscal_package_adoptions
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_package_adoption();

ALTER TABLE fiscal_package_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_package_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_package_adoptions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

-- The catalogue belongs to no workspace: every workspace reads all of it, and the policy says
-- so, with row security forced as on every Fiscal table. The application has no write grant.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['fiscal_catalog_packages', 'fiscal_catalog_references', 'fiscal_catalog_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY catalogue_read ON %I FOR SELECT TO horizon_app USING (true)', table_name);
    EXECUTE format('CREATE POLICY catalogue_publish ON %I TO %I USING (true) WITH CHECK (true)', table_name, current_user);
  END LOOP;
END $$;

GRANT SELECT ON fiscal_catalog_packages, fiscal_catalog_references, fiscal_catalog_rules TO horizon_app;
GRANT SELECT, INSERT ON fiscal_package_adoptions TO horizon_app;
GRANT USAGE, SELECT ON SEQUENCE fiscal_package_adoptions_sequence_seq TO horizon_app;

CREATE TRIGGER fiscal_catalog_packages_immutable BEFORE UPDATE OR DELETE ON fiscal_catalog_packages
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_catalog_references_immutable BEFORE UPDATE OR DELETE ON fiscal_catalog_references
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_catalog_rules_immutable BEFORE UPDATE OR DELETE ON fiscal_catalog_rules
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_package_adoptions_immutable BEFORE UPDATE OR DELETE ON fiscal_package_adoptions
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
