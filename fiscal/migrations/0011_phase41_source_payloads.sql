CREATE TABLE fiscal_source_payloads (
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  source_bytes bytea NOT NULL CHECK (octet_length(source_bytes) > 0),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  imported_by text NOT NULL CHECK (length(imported_by) BETWEEN 1 AND 200),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, package_id),
  CONSTRAINT fiscal_source_payload_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id)
);

CREATE FUNCTION validate_fiscal_package_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  importer text;
BEGIN
  SELECT imported_by INTO importer
  FROM fiscal_source_payloads
  WHERE tenant_id = NEW.tenant_id AND package_id = NEW.package_id;
  IF importer IS NULL THEN
    RAISE EXCEPTION 'source package bytes must be retained before review' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved AND importer = NEW.reviewed_by THEN
    RAISE EXCEPTION 'source package importer cannot approve their own import' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_package_review_separation BEFORE INSERT ON fiscal_package_reviews
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_package_review();

ALTER TABLE fiscal_source_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_source_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_source_payloads TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_source_payloads TO horizon_app;
CREATE TRIGGER fiscal_source_payloads_immutable BEFORE UPDATE OR DELETE ON fiscal_source_payloads
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
