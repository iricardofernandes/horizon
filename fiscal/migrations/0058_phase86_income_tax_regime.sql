-- Phase 86: the issuer's income-tax regime (Lucro Real or Presumido), which decides the
-- PIS/Cofins method, as a dimension of its own. The issuer regime keeps the NF-e's CRT meaning
-- (normal, simples-nacional, mei), to which the approved rules of Phases 41 to 47 are scoped.
ALTER TABLE fiscal_tax_rules
  ADD COLUMN issuer_income_tax_regime text NOT NULL DEFAULT '*'
    CHECK (issuer_income_tax_regime IN ('*', 'lucro-real', 'lucro-presumido'));
ALTER TABLE fiscal_catalog_rules
  ADD COLUMN issuer_income_tax_regime text NOT NULL DEFAULT '*'
    CHECK (issuer_income_tax_regime IN ('*', 'lucro-real', 'lucro-presumido'));

-- The overlap guards see it, or two rules differing only in it would clash.
CREATE OR REPLACE FUNCTION reject_overlapping_fiscal_tax_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.component_group || ':' || NEW.component_code || ':' || NEW.precedence || ':' || NEW.priority::text || ':' || NEW.date_basis || ':' || NEW.purpose || ':' || NEW.model || ':' || NEW.environment || ':' || NEW.operation || ':' || NEW.issuer_establishment_id || ':' || NEW.issuer_regime || ':' || NEW.recipient_party_id || ':' || NEW.recipient_regime || ':' || NEW.origin_state || ':' || NEW.destination_state || ':' || NEW.subject_kind || ':' || NEW.subject_id || ':' || NEW.classification_kind || ':' || NEW.classification_code || ':' || NEW.recipient_taxpayer || ':' || NEW.issuer_municipality || ':' || NEW.fact_key || ':' || NEW.fact_value || ':' || NEW.issuer_income_tax_regime,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_tax_rules existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.component_group = NEW.component_group
      AND existing.component_code = NEW.component_code
      AND existing.precedence = NEW.precedence
      AND existing.priority = NEW.priority
      AND existing.date_basis = NEW.date_basis
      AND existing.purpose = NEW.purpose
      AND existing.model = NEW.model
      AND existing.environment = NEW.environment
      AND existing.operation = NEW.operation
      AND existing.issuer_establishment_id = NEW.issuer_establishment_id
      AND existing.issuer_regime = NEW.issuer_regime
      AND existing.recipient_party_id = NEW.recipient_party_id
      AND existing.recipient_regime = NEW.recipient_regime
      AND existing.origin_state = NEW.origin_state
      AND existing.destination_state = NEW.destination_state
      AND existing.subject_kind = NEW.subject_kind
      AND existing.subject_id = NEW.subject_id
      AND existing.classification_kind = NEW.classification_kind
      AND existing.classification_code = NEW.classification_code
      AND existing.recipient_taxpayer = NEW.recipient_taxpayer
      AND existing.issuer_municipality = NEW.issuer_municipality
      AND existing.fact_key = NEW.fact_key
      AND existing.fact_value = NEW.fact_value
      AND existing.issuer_income_tax_regime = NEW.issuer_income_tax_regime
      AND daterange(existing.effective_from, existing.effective_to, '[)') &&
          daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping equal-priority fiscal tax rule' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION reject_overlapping_fiscal_catalog_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'catalog:' || NEW.component_group || ':' || NEW.component_code || ':' || NEW.precedence || ':' || NEW.priority::text || ':' || NEW.purpose || ':' || NEW.model || ':' || NEW.environment || ':' || NEW.operation || ':' || NEW.issuer_regime || ':' || NEW.recipient_regime || ':' || NEW.origin_state || ':' || NEW.destination_state || ':' || NEW.classification_kind || ':' || NEW.classification_code || ':' || NEW.recipient_taxpayer || ':' || NEW.issuer_municipality || ':' || NEW.fact_key || ':' || NEW.fact_value || ':' || NEW.issuer_income_tax_regime,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_catalog_rules existing
    WHERE existing.component_group = NEW.component_group
      AND existing.component_code = NEW.component_code
      AND existing.precedence = NEW.precedence
      AND existing.priority = NEW.priority
      AND existing.purpose = NEW.purpose
      AND existing.model = NEW.model
      AND existing.environment = NEW.environment
      AND existing.operation = NEW.operation
      AND existing.issuer_regime = NEW.issuer_regime
      AND existing.recipient_regime = NEW.recipient_regime
      AND existing.origin_state = NEW.origin_state
      AND existing.destination_state = NEW.destination_state
      AND existing.classification_kind = NEW.classification_kind
      AND existing.classification_code = NEW.classification_code
      AND existing.recipient_taxpayer = NEW.recipient_taxpayer
      AND existing.issuer_municipality = NEW.issuer_municipality
      AND existing.fact_key = NEW.fact_key
      AND existing.fact_value = NEW.fact_value
      AND existing.issuer_income_tax_regime = NEW.issuer_income_tax_regime
      AND daterange(existing.effective_from, existing.effective_to, '[)') &&
          daterange(NEW.effective_from, NEW.effective_to, '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping equal-priority fiscal catalogue rule' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;
