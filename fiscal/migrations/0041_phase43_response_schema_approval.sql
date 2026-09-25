-- Response XSD archives are reviewed independently of the document and event
-- packages. An exchange may be sent or reparsed only with this exact pair.
CREATE TABLE fiscal_homologation_response_schema_approvals (
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  document_schema_digest text NOT NULL CHECK (document_schema_digest ~ '^[0-9a-f]{64}$'),
  consultation_schema_digest text NOT NULL CHECK (consultation_schema_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_id),
  FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_response_schema_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP'
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.created_by = NEW.reviewed_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation response schemas differ from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES (NEW.document_schema_digest), (NEW.consultation_schema_digest)) AS selected(digest)
    WHERE NOT EXISTS (
      SELECT 1 FROM fiscal_source_packages package
      JOIN fiscal_source_payloads payload
        ON payload.tenant_id = package.tenant_id AND payload.package_id = package.id
      JOIN fiscal_package_reviews review
        ON review.tenant_id = package.tenant_id AND review.package_id = package.id
      WHERE package.tenant_id = NEW.tenant_id AND package.package_digest = selected.digest
        AND payload.byte_size = octet_length(payload.source_bytes)
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    )
  ) THEN
    RAISE EXCEPTION 'Homologation response schemas lack retained reviewed bytes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_response_schema_approval_valid
  BEFORE INSERT ON fiscal_homologation_response_schema_approvals
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_response_schema_approval();

ALTER TABLE fiscal_homologation_response_schema_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_response_schema_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_response_schema_approvals TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_response_schema_approvals TO horizon_app;
CREATE TRIGGER fiscal_homologation_response_schema_approvals_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_response_schema_approvals FOR EACH ROW
  EXECUTE FUNCTION reject_fiscal_immutable_mutation();

-- Evidence from exchanges started before the response packages were reviewed
-- cannot be used to activate a homologated capability after this migration.
CREATE FUNCTION require_fiscal_homologation_activation_response_schemas()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'activate_homologated' AND NOT EXISTS (
    SELECT 1 FROM fiscal_capability_homologation_evidence evidence
    JOIN fiscal_homologation_response_schema_approvals approval
      ON approval.tenant_id = evidence.tenant_id
      AND approval.capability_id = evidence.capability_id
    JOIN fiscal_homologation_transmissions authorization_send
      ON authorization_send.tenant_id = evidence.tenant_id
      AND authorization_send.exchange_id = evidence.authorization_exchange_id
    JOIN fiscal_homologation_transmissions consultation_send
      ON consultation_send.tenant_id = evidence.tenant_id
      AND consultation_send.exchange_id = evidence.consultation_exchange_id
    JOIN fiscal_homologation_transmissions cancellation_send
      ON cancellation_send.tenant_id = evidence.tenant_id
      AND cancellation_send.exchange_id = evidence.cancellation_exchange_id
    WHERE evidence.tenant_id = NEW.tenant_id
      AND evidence.capability_id = NEW.capability_id
      AND evidence.round_trip_digest = NEW.evidence_digest
      AND approval.reviewed_at <= authorization_send.started_at
      AND approval.reviewed_at <= consultation_send.started_at
      AND approval.reviewed_at <= cancellation_send.started_at
  ) THEN
    RAISE EXCEPTION 'homologation activation lacks prior response schema approval'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_activation_response_schemas_valid
  BEFORE INSERT ON fiscal_capability_activation_events
  FOR EACH ROW EXECUTE FUNCTION require_fiscal_homologation_activation_response_schemas();
