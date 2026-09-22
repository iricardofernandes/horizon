CREATE TABLE fiscal_package_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  approved boolean NOT NULL,
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL,
  interpretation text NOT NULL CHECK (length(interpretation) BETWEEN 1 AND 4000),
  fixture_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_package_review_once UNIQUE (tenant_id, package_id),
  CONSTRAINT fiscal_package_review_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id),
  CONSTRAINT fiscal_package_review_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE fiscal_reference_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
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
  CONSTRAINT fiscal_reference_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fiscal_reference_entry_key UNIQUE (
    tenant_id, package_id, family, code, model, jurisdiction, effective_from
  ),
  CONSTRAINT fiscal_reference_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id),
  CONSTRAINT fiscal_reference_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE fiscal_tax_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  rule_key text NOT NULL CHECK (length(rule_key) BETWEEN 1 AND 120),
  version integer NOT NULL CHECK (version > 0),
  component_group text NOT NULL CHECK (component_group IN ('legacy', 'ibs_cbs')),
  component_code text NOT NULL CHECK (component_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  precedence text NOT NULL CHECK (
    precedence IN ('operation', 'establishment', 'item', 'party', 'default')
  ),
  priority integer NOT NULL CHECK (priority >= 0),
  model text NOT NULL CHECK (model IN ('55', '65', 'nfse')),
  environment text NOT NULL CHECK (environment IN ('simulation', 'homologation', 'production')),
  operation text NOT NULL DEFAULT '*',
  issuer_establishment_id text NOT NULL DEFAULT '*',
  issuer_regime text NOT NULL DEFAULT '*',
  recipient_regime text NOT NULL DEFAULT '*',
  origin_state text NOT NULL DEFAULT '*',
  destination_state text NOT NULL DEFAULT '*',
  subject_kind text NOT NULL DEFAULT '*' CHECK (subject_kind IN ('*', 'item', 'service')),
  subject_id text NOT NULL DEFAULT '*',
  classification_kind text NOT NULL DEFAULT '*' CHECK (
    classification_kind IN ('*', 'ncm', 'cest', 'service', 'origin')
  ),
  classification_code text NOT NULL DEFAULT '*',
  effective_from date NOT NULL,
  effective_to date,
  rate_numerator text NOT NULL CHECK (rate_numerator ~ '^-?\d+$'),
  rate_denominator text NOT NULL CHECK (rate_denominator ~ '^[1-9]\d*$'),
  formula text NOT NULL CHECK (formula = 'LINE_NET_TIMES_RATE'),
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 300),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_tax_rule_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fiscal_tax_rule_version_key UNIQUE (tenant_id, rule_key, version),
  CONSTRAINT fiscal_tax_rule_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES fiscal_source_packages(tenant_id, id),
  CONSTRAINT fiscal_tax_rule_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE fiscal_rule_activation_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('activate', 'deactivate')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_rule_activation_rule_fk FOREIGN KEY (tenant_id, rule_id)
    REFERENCES fiscal_tax_rules(tenant_id, id),
  CONSTRAINT fiscal_rule_activation_idempotency UNIQUE (tenant_id, rule_id, action, reason),
  CONSTRAINT fiscal_rule_activation_tenant_id_key UNIQUE (tenant_id, id)
);

-- Equal-priority definitions with the exact same scope may never overlap. The advisory
-- lock makes the check safe when two import transactions race.
CREATE FUNCTION reject_overlapping_fiscal_tax_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.component_group || ':' || NEW.component_code || ':' ||
    NEW.precedence || ':' || NEW.priority::text || ':' || NEW.model || ':' || NEW.environment || ':' ||
    NEW.operation || ':' || NEW.issuer_establishment_id || ':' || NEW.issuer_regime || ':' ||
    NEW.recipient_regime || ':' || NEW.origin_state || ':' || NEW.destination_state || ':' ||
    NEW.subject_kind || ':' || NEW.subject_id || ':' || NEW.classification_kind || ':' ||
    NEW.classification_code,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_tax_rules existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.component_group = NEW.component_group
      AND existing.component_code = NEW.component_code
      AND existing.precedence = NEW.precedence
      AND existing.priority = NEW.priority
      AND existing.model = NEW.model
      AND existing.environment = NEW.environment
      AND existing.operation = NEW.operation
      AND existing.issuer_establishment_id = NEW.issuer_establishment_id
      AND existing.issuer_regime = NEW.issuer_regime
      AND existing.recipient_regime = NEW.recipient_regime
      AND existing.origin_state = NEW.origin_state
      AND existing.destination_state = NEW.destination_state
      AND existing.subject_kind = NEW.subject_kind
      AND existing.subject_id = NEW.subject_id
      AND existing.classification_kind = NEW.classification_kind
      AND existing.classification_code = NEW.classification_code
      AND daterange(existing.effective_from, existing.effective_to, '[)') &&
          daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping equal-priority fiscal tax rule' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_tax_rules_no_overlap BEFORE INSERT ON fiscal_tax_rules
  FOR EACH ROW EXECUTE FUNCTION reject_overlapping_fiscal_tax_rule();

CREATE FUNCTION validate_fiscal_rule_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_action text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':' || NEW.rule_id::text, 0));
  SELECT action INTO latest_action
  FROM fiscal_rule_activation_events
  WHERE tenant_id = NEW.tenant_id AND rule_id = NEW.rule_id
  ORDER BY sequence DESC LIMIT 1;
  IF NEW.action = 'activate' THEN
    IF latest_action = 'activate' THEN
      RAISE EXCEPTION 'fiscal tax rule is already active' USING ERRCODE = '23505';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM fiscal_tax_rules rule
      JOIN fiscal_package_reviews review
        ON review.tenant_id = rule.tenant_id AND review.package_id = rule.package_id
      WHERE rule.tenant_id = NEW.tenant_id AND rule.id = NEW.rule_id AND review.approved
    ) THEN
      RAISE EXCEPTION 'fiscal tax rule source package is not approved' USING ERRCODE = '23514';
    END IF;
  ELSIF latest_action IS DISTINCT FROM 'activate' THEN
    RAISE EXCEPTION 'inactive fiscal tax rule cannot be deactivated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_rule_activation_valid BEFORE INSERT ON fiscal_rule_activation_events
  FOR EACH ROW EXECUTE FUNCTION validate_fiscal_rule_activation();

ALTER TABLE fiscal_package_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_package_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_package_reviews TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_reference_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_reference_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_reference_entries TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_tax_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_tax_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_tax_rules TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE fiscal_rule_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_rule_activation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_rule_activation_events TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_package_reviews, fiscal_reference_entries, fiscal_tax_rules,
  fiscal_rule_activation_events TO horizon_app;
GRANT USAGE, SELECT ON SEQUENCE fiscal_rule_activation_events_sequence_seq TO horizon_app;

CREATE TRIGGER fiscal_package_reviews_immutable BEFORE UPDATE OR DELETE ON fiscal_package_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_reference_entries_immutable BEFORE UPDATE OR DELETE ON fiscal_reference_entries
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_tax_rules_immutable BEFORE UPDATE OR DELETE ON fiscal_tax_rules
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_rule_activation_events_immutable BEFORE UPDATE OR DELETE ON fiscal_rule_activation_events
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
