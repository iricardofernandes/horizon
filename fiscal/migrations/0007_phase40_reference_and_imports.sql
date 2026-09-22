CREATE TABLE fiscal_source_packages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  authority text NOT NULL,
  source_uri text NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  published_at date NOT NULL,
  effective_from date NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_source_package_key UNIQUE (tenant_id, authority, package_digest),
  CONSTRAINT fiscal_source_package_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE fiscal_rule_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  rule_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fiscal_rule_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fiscal_rule_version_key UNIQUE (tenant_id, rule_key, version),
  CONSTRAINT fiscal_rule_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id)
);

CREATE TABLE fiscal_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 128),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'staged' CHECK (status = 'staged'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_import_external_key UNIQUE (tenant_id, external_key),
  CONSTRAINT fiscal_import_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE inbound_matches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  import_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'committed')),
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_match_key UNIQUE (tenant_id, import_id, receipt_id, status),
  CONSTRAINT inbound_match_import_fk FOREIGN KEY (tenant_id, import_id)
    REFERENCES fiscal_imports(tenant_id, id)
);

ALTER TABLE fiscal_source_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_source_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_source_packages TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_rule_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_rule_versions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_imports TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE inbound_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inbound_matches TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_source_packages, fiscal_rule_versions, fiscal_imports,
  inbound_matches TO horizon_app;
CREATE TRIGGER fiscal_source_packages_immutable BEFORE UPDATE OR DELETE ON fiscal_source_packages
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_rule_versions_immutable BEFORE UPDATE OR DELETE ON fiscal_rule_versions
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_imports_immutable BEFORE UPDATE OR DELETE ON fiscal_imports
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER inbound_matches_immutable BEFORE UPDATE OR DELETE ON inbound_matches
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
