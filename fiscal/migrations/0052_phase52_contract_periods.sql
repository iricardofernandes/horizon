-- Phase 52: a billed contract period becomes NFS-e exactly as a delivered service does
-- (ADR 0056). Each billed line is one intake, keyed by its entry id; the intake names the
-- billed period and the contract instead of a delivery and a service order.
ALTER TABLE fiscal_service_intakes
  DROP CONSTRAINT fiscal_service_intakes_source_document_type_check;
ALTER TABLE fiscal_service_intakes
  ADD CONSTRAINT fiscal_service_intakes_source_document_type_check
    CHECK (source_document_type IN ('service-delivery', 'contract-period'));
ALTER TABLE fiscal_service_intakes
  ALTER COLUMN delivery_id DROP NOT NULL,
  ALTER COLUMN service_order_id DROP NOT NULL,
  ADD COLUMN billed_period_id uuid,
  ADD COLUMN contract_id uuid,
  -- The NFS-e cancellation reason a withdrawal asks for: 2, service not provided (the
  -- default), or 1, issued in error.
  ADD COLUMN withdrawal_code text CHECK (withdrawal_code IN ('1', '2'));
ALTER TABLE fiscal_service_intakes
  ADD CONSTRAINT fiscal_service_intake_document_check CHECK (
    (source_document_type = 'service-delivery'
      AND delivery_id IS NOT NULL AND service_order_id IS NOT NULL
      AND billed_period_id IS NULL AND contract_id IS NULL)
    OR (source_document_type = 'contract-period'
      AND billed_period_id IS NOT NULL AND contract_id IS NOT NULL
      AND delivery_id IS NULL AND service_order_id IS NULL)
  ),
  ADD CONSTRAINT fiscal_service_intake_withdrawal_code_check CHECK (
    withdrawal_code IS NULL OR withdrawal_requested
  );
CREATE INDEX fiscal_service_intakes_billed_period
  ON fiscal_service_intakes (tenant_id, billed_period_id) WHERE billed_period_id IS NOT NULL;
CREATE INDEX fiscal_service_intakes_period
  ON fiscal_service_intakes (tenant_id, source_document_type, period);

CREATE OR REPLACE FUNCTION guard_fiscal_service_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR (OLD.id, OLD.tenant_id, OLD.source_module, OLD.source_document_type, OLD.entry_id,
        OLD.period, OLD.delivery_id, OLD.service_order_id, OLD.billed_period_id,
        OLD.contract_id, OLD.customer_id, OLD.service_item_id, OLD.competence_date,
        OLD.amount_minor, OLD.currency, OLD.description, OLD.facts_digest, OLD.created_at)
      IS DISTINCT FROM
       (NEW.id, NEW.tenant_id, NEW.source_module, NEW.source_document_type, NEW.entry_id,
        NEW.period, NEW.delivery_id, NEW.service_order_id, NEW.billed_period_id,
        NEW.contract_id, NEW.customer_id, NEW.service_item_id, NEW.competence_date,
        NEW.amount_minor, NEW.currency, NEW.description, NEW.facts_digest, NEW.created_at)
    OR (OLD.establishment_id IS NOT NULL
        AND NEW.establishment_id IS DISTINCT FROM OLD.establishment_id)
    OR (OLD.service_origin_id IS NOT NULL
        AND NEW.service_origin_id IS DISTINCT FROM OLD.service_origin_id)
    OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
    OR (OLD.withdrawal_requested AND NOT NEW.withdrawal_requested)
    OR (OLD.withdrawal_requested AND NEW.withdrawal_code IS DISTINCT FROM OLD.withdrawal_code)
    OR OLD.status = 'withdrawn'
  THEN
    RAISE EXCEPTION 'A fiscal service intake only moves forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
