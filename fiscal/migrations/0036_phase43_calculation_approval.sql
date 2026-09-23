-- Bind the homologation capability to the exact independently reviewed rule
-- packages used by a supported calculation. A different package set cannot
-- quietly become issuance evidence.
CREATE TABLE fiscal_homologation_calculation_approvals (
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  calculation_fixture_id text NOT NULL CHECK (length(calculation_fixture_id) BETWEEN 1 AND 160),
  package_digests text[] NOT NULL CHECK (cardinality(package_digests) BETWEEN 1 AND 20),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_id),
  FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_calculation_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
DECLARE expected_digest text;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP'
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.calculation_fixture_id <> NEW.calculation_fixture_id
    OR definition.created_by = NEW.reviewed_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation calculation approval differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.package_digests <> (
    SELECT array_agg(candidate ORDER BY candidate)
    FROM (SELECT DISTINCT candidate
      FROM unnest(NEW.package_digests) AS digest(candidate)) sorted
  ) THEN
    RAISE EXCEPTION 'Homologation calculation packages must be sorted and unique'
      USING ERRCODE = '23514';
  END IF;
  FOREACH expected_digest IN ARRAY NEW.package_digests LOOP
    IF expected_digest !~ '^[0-9a-f]{64}$' OR NOT EXISTS (
      SELECT 1 FROM fiscal_source_packages package
      JOIN fiscal_package_reviews review
        ON review.tenant_id = package.tenant_id AND review.package_id = package.id
      WHERE package.tenant_id = NEW.tenant_id
        AND package.package_digest = expected_digest
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
        AND NEW.calculation_fixture_id = ANY(review.fixture_ids)
    ) THEN
      RAISE EXCEPTION 'Homologation calculation package lacks matching independent review'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_calculation_approval_valid
  BEFORE INSERT ON fiscal_homologation_calculation_approvals
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_calculation_approval();

ALTER TABLE fiscal_homologation_calculation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_calculation_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_calculation_approvals TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_calculation_approvals TO horizon_app;
CREATE TRIGGER fiscal_homologation_calculation_approvals_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_calculation_approvals FOR EACH ROW
  EXECUTE FUNCTION reject_fiscal_immutable_mutation();

CREATE FUNCTION verify_fiscal_homologation_ready_calculation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment <> 'homologation' OR OLD.status <> 'draft'
    OR NEW.status <> 'ready' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_document_readiness_bindings readiness
    JOIN fiscal_document_calculation_bindings binding
      ON binding.tenant_id = readiness.tenant_id
      AND binding.document_id = readiness.document_id
    JOIN fiscal_calculations calculation
      ON calculation.tenant_id = binding.tenant_id
      AND calculation.id = binding.calculation_id
    JOIN fiscal_homologation_calculation_approvals approval
      ON approval.tenant_id = readiness.tenant_id
      AND approval.capability_id = readiness.capability_id
    JOIN fiscal_capability_definitions definition
      ON definition.tenant_id = approval.tenant_id
      AND definition.id = approval.capability_id
    WHERE readiness.tenant_id = NEW.tenant_id
      AND readiness.document_id = NEW.id
      AND readiness.origin_digest = NEW.snapshot_digest
      AND calculation.document_id = NEW.id
      AND definition.establishment_id = NEW.establishment_id
      AND definition.environment = 'homologation'
      AND calculation.package_digests = approval.package_digests
  ) THEN
    RAISE EXCEPTION 'Homologation readiness requires the exact reviewed calculation packages'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_ready_calculation_valid
  BEFORE UPDATE OF status ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_ready_calculation();

CREATE FUNCTION verify_fiscal_homologation_authorization_ready()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_documents document
    WHERE document.tenant_id = NEW.tenant_id AND document.id = NEW.document_id
      AND document.environment = 'homologation' AND document.status = 'ready'
  ) THEN
    RAISE EXCEPTION 'Homologation authorization requires a ready document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_authorization_ready_valid
  BEFORE INSERT ON fiscal_homologation_authorization_bindings
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_authorization_ready();
