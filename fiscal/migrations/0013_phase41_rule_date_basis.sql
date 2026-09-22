ALTER TABLE fiscal_tax_rules ADD COLUMN date_basis text NOT NULL DEFAULT 'issue_date'
  CHECK (date_basis IN ('issue_date', 'competence_date'));

CREATE OR REPLACE FUNCTION reject_overlapping_fiscal_tax_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.component_group || ':' || NEW.component_code || ':' ||
    NEW.precedence || ':' || NEW.priority::text || ':' || NEW.date_basis || ':' || NEW.model || ':' ||
    NEW.environment || ':' || NEW.operation || ':' || NEW.issuer_establishment_id || ':' ||
    NEW.issuer_regime || ':' || NEW.recipient_regime || ':' || NEW.origin_state || ':' ||
    NEW.destination_state || ':' || NEW.subject_kind || ':' || NEW.subject_id || ':' ||
    NEW.classification_kind || ':' || NEW.classification_code,
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
