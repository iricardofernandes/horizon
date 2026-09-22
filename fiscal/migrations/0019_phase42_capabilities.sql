CREATE TABLE fiscal_capability_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  establishment_id uuid NOT NULL,
  jurisdiction_kind text NOT NULL CHECK (jurisdiction_kind IN ('uf', 'municipality', 'national')),
  jurisdiction_code text NOT NULL CHECK (length(jurisdiction_code) BETWEEN 2 AND 20),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9-]{0,79}$'),
  adapter_version text NOT NULL CHECK (adapter_version ~ '^[a-z][a-z0-9.-]{0,79}$'),
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  schema_package_digest text NOT NULL CHECK (schema_package_digest ~ '^[0-9a-f]{64}$'),
  calculation_fixture_id text NOT NULL CHECK (length(calculation_fixture_id) BETWEEN 1 AND 160),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_capability_definition_key UNIQUE (
    tenant_id, model, environment, establishment_id, jurisdiction_kind,
    jurisdiction_code, operation, adapter_version
  ),
  CONSTRAINT fiscal_capability_definition_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_capability_model_jurisdiction CHECK (
    (model IN ('55', '65') AND jurisdiction_kind = 'uf' AND jurisdiction_code ~ '^[A-Z]{2}$') OR
    (model = 'nfse' AND jurisdiction_kind IN ('municipality', 'national'))
  )
);

CREATE TABLE fiscal_capability_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  approved boolean NOT NULL,
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  interpretation text NOT NULL CHECK (length(interpretation) BETWEEN 10 AND 4000),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_capability_review_definition_fk FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id),
  CONSTRAINT fiscal_capability_review_once UNIQUE (tenant_id, capability_id)
);

CREATE TABLE fiscal_capability_activation_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('activate_simulated', 'deactivate')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_capability_activation_definition_fk FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id),
  CONSTRAINT fiscal_capability_activation_idempotent UNIQUE (
    tenant_id, capability_id, action, evidence_digest
  )
);

CREATE FUNCTION validate_fiscal_capability_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creator text;
BEGIN
  SELECT created_by INTO creator FROM fiscal_capability_definitions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF creator = NEW.reviewed_by THEN
    RAISE EXCEPTION 'Fiscal capability requires an independent reviewer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_capability_review_valid BEFORE INSERT ON fiscal_capability_reviews
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_capability_review();

CREATE FUNCTION validate_fiscal_capability_activation() RETURNS trigger LANGUAGE plpgsql AS $$
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

  IF NEW.action = 'activate_simulated' THEN
    IF definition.environment <> 'simulation' THEN
      RAISE EXCEPTION 'simulated activation requires the simulation environment'
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
        AND latest.action = 'activate_simulated'
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

CREATE TRIGGER fiscal_capability_activation_valid
  BEFORE INSERT ON fiscal_capability_activation_events
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_capability_activation();

ALTER TABLE fiscal_capability_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_capability_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_capability_definitions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_capability_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_capability_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_capability_reviews TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_capability_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_capability_activation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_capability_activation_events TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_capability_definitions, fiscal_capability_reviews,
  fiscal_capability_activation_events TO horizon_app;
CREATE TRIGGER fiscal_capability_definitions_immutable BEFORE UPDATE OR DELETE
  ON fiscal_capability_definitions FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_capability_reviews_immutable BEFORE UPDATE OR DELETE
  ON fiscal_capability_reviews FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_capability_activation_events_immutable BEFORE UPDATE OR DELETE
  ON fiscal_capability_activation_events FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
