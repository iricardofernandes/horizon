-- A homologated capability is a separate, evidence-backed environment.
ALTER TABLE fiscal_capability_activation_events
  DROP CONSTRAINT fiscal_capability_activation_events_action_check;
ALTER TABLE fiscal_capability_activation_events
  ADD CONSTRAINT fiscal_capability_activation_events_action_check
  CHECK (action IN ('activate_simulated', 'activate_homologated', 'deactivate'));

CREATE TABLE fiscal_capability_homologation_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  endpoint_set_digest text NOT NULL CHECK (endpoint_set_digest ~ '^[0-9a-f]{64}$'),
  certificate_fingerprint text NOT NULL CHECK (certificate_fingerprint ~ '^[0-9a-f]{64}$'),
  round_trip_digest text NOT NULL CHECK (round_trip_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_homologation_evidence_once UNIQUE (tenant_id, capability_id),
  CONSTRAINT fiscal_homologation_evidence_capability_fk FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id)
);

CREATE FUNCTION validate_fiscal_homologation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' THEN
    RAISE EXCEPTION 'homologation evidence requires an NF-e 55 UF capability'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_manifest_digest <> definition.source_manifest_digest THEN
    RAISE EXCEPTION 'homologation evidence source differs from capability'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewed_by = definition.created_by THEN
    RAISE EXCEPTION 'homologation evidence requires an independent reviewer'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_capability_reviews review
    WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
      AND review.approved AND review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'homologation evidence requires the capability reviewer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_homologation_evidence_valid
  BEFORE INSERT ON fiscal_capability_homologation_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_homologation_evidence();

CREATE OR REPLACE FUNCTION validate_fiscal_capability_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || definition.model || ':' || definition.environment || ':' ||
    definition.establishment_id::text || ':' || definition.jurisdiction_kind || ':' ||
    definition.jurisdiction_code || ':' || definition.operation,
    0
  ));

  IF NEW.action IN ('activate_simulated', 'activate_homologated') THEN
    IF (NEW.action = 'activate_simulated' AND definition.environment <> 'simulation') OR
       (NEW.action = 'activate_homologated' AND definition.environment <> 'homologation') THEN
      RAISE EXCEPTION 'Fiscal capability activation environment mismatch'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved
    ) THEN
      RAISE EXCEPTION 'Fiscal capability is not approved'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.action = 'activate_homologated' AND NOT EXISTS (
      SELECT 1 FROM fiscal_capability_homologation_evidence evidence
      WHERE evidence.tenant_id = NEW.tenant_id AND evidence.capability_id = NEW.capability_id
        AND evidence.round_trip_digest = NEW.evidence_digest
    ) THEN
      RAISE EXCEPTION 'Fiscal homologation evidence is missing'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM fiscal_capability_definitions other
      JOIN LATERAL (
        SELECT event.action FROM fiscal_capability_activation_events event
        WHERE event.tenant_id = other.tenant_id AND event.capability_id = other.id
        ORDER BY event.created_at DESC, event.id DESC LIMIT 1
      ) latest ON true
      WHERE other.tenant_id = NEW.tenant_id AND other.id <> NEW.capability_id
        AND other.model = definition.model AND other.environment = definition.environment
        AND other.establishment_id = definition.establishment_id
        AND other.jurisdiction_kind = definition.jurisdiction_kind
        AND other.jurisdiction_code = definition.jurisdiction_code
        AND other.operation = definition.operation
        AND latest.action IN ('activate_simulated', 'activate_homologated')
    ) THEN
      RAISE EXCEPTION 'another Fiscal adapter is active for this capability tuple'
        USING ERRCODE = '23505';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM fiscal_capability_activation_events event
    WHERE event.tenant_id = NEW.tenant_id AND event.capability_id = NEW.capability_id
  ) THEN
    RAISE EXCEPTION 'Fiscal capability has not been activated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE fiscal_capability_homologation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_capability_homologation_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_capability_homologation_evidence TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_capability_homologation_evidence TO horizon_app;
CREATE TRIGGER fiscal_capability_homologation_evidence_immutable BEFORE UPDATE OR DELETE
  ON fiscal_capability_homologation_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
