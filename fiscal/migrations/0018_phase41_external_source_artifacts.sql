CREATE TABLE fiscal_source_artifacts (
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  storage_uri text NOT NULL CHECK (length(storage_uri) BETWEEN 1 AND 2000),
  verified_at timestamptz NOT NULL,
  retained_by text NOT NULL CHECK (length(retained_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, package_id),
  CONSTRAINT fiscal_source_artifact_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id),
  CONSTRAINT fiscal_source_artifact_digest_unique UNIQUE (tenant_id, artifact_digest),
  CONSTRAINT fiscal_source_artifact_package_digest_matches CHECK (artifact_digest <> '')
);

CREATE FUNCTION validate_fiscal_source_artifact_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_source_packages package
    WHERE package.tenant_id = NEW.tenant_id AND package.id = NEW.package_id
      AND package.package_digest = NEW.artifact_digest
  ) THEN
    RAISE EXCEPTION 'retained Fiscal artifact digest does not match its package'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_source_artifact_digest_valid BEFORE INSERT ON fiscal_source_artifacts
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_source_artifact_digest();

ALTER TABLE fiscal_source_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_source_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_source_artifacts TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_source_artifacts TO horizon_app;
CREATE TRIGGER fiscal_source_artifacts_immutable BEFORE UPDATE OR DELETE ON fiscal_source_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
