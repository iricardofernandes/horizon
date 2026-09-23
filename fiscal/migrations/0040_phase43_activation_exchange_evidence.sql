-- A reviewer digest cannot activate homologation without the exact durable
-- authorization, consultation and cancellation exchanges it summarizes.
ALTER TABLE fiscal_capability_homologation_evidence
  ADD COLUMN authorization_exchange_id uuid,
  ADD COLUMN consultation_exchange_id uuid,
  ADD COLUMN cancellation_exchange_id uuid;

CREATE OR REPLACE FUNCTION validate_fiscal_homologation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP'
    OR definition.operation <> 'normal-sale'
    OR NEW.source_manifest_digest <> definition.source_manifest_digest
    OR NEW.reviewed_by = definition.created_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'homologation evidence differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.authorization_exchange_id IS NULL OR NEW.consultation_exchange_id IS NULL
    OR NEW.cancellation_exchange_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM fiscal_homologation_exchanges auth_exchange
      JOIN fiscal_homologation_drill_grants grant_row
        ON grant_row.tenant_id = auth_exchange.tenant_id
        AND grant_row.id = auth_exchange.drill_grant_id
      JOIN fiscal_homologation_transmissions authorization_send
        ON authorization_send.tenant_id = auth_exchange.tenant_id
        AND authorization_send.exchange_id = auth_exchange.id
      JOIN fiscal_homologation_exchanges consultation
        ON consultation.tenant_id = auth_exchange.tenant_id
        AND consultation.id = NEW.consultation_exchange_id
        AND consultation.parent_exchange_id = auth_exchange.id
        AND consultation.document_id = auth_exchange.document_id
        AND consultation.access_key = auth_exchange.access_key
        AND consultation.service IN ('receipt', 'protocol')
      JOIN fiscal_homologation_parsed_responses authorized
        ON authorized.tenant_id = consultation.tenant_id
        AND authorized.exchange_id = consultation.id
        AND authorized.decision = 'authorized'
        AND authorized.protocol_number IS NOT NULL
      JOIN fiscal_homologation_exchanges cancellation
        ON cancellation.tenant_id = auth_exchange.tenant_id
        AND cancellation.id = NEW.cancellation_exchange_id
        AND cancellation.parent_exchange_id = auth_exchange.id
        AND cancellation.document_id = auth_exchange.document_id
        AND cancellation.access_key = auth_exchange.access_key
        AND cancellation.service = 'event'
        AND cancellation.authorization_protocol = authorized.protocol_number
      JOIN fiscal_homologation_parsed_responses cancelled
        ON cancelled.tenant_id = cancellation.tenant_id
        AND cancelled.exchange_id = cancellation.id
        AND cancelled.decision = 'cancelled'
      WHERE auth_exchange.tenant_id = NEW.tenant_id
        AND auth_exchange.id = NEW.authorization_exchange_id
        AND auth_exchange.service = 'authorization'
        AND grant_row.capability_id = NEW.capability_id
        AND auth_exchange.endpoint_digest = NEW.endpoint_set_digest
        AND auth_exchange.certificate_fingerprint = NEW.certificate_fingerprint
  ) THEN
    RAISE EXCEPTION 'homologation evidence lacks linked authorized consultation and cancellation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Existing unsigned evidence rows cannot activate a capability after upgrade.
CREATE OR REPLACE FUNCTION require_fiscal_homologation_activation_exchanges()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'activate_homologated' AND NOT EXISTS (
    SELECT 1 FROM fiscal_capability_homologation_evidence evidence
    WHERE evidence.tenant_id = NEW.tenant_id
      AND evidence.capability_id = NEW.capability_id
      AND evidence.round_trip_digest = NEW.evidence_digest
      AND evidence.authorization_exchange_id IS NOT NULL
      AND evidence.consultation_exchange_id IS NOT NULL
      AND evidence.cancellation_exchange_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'homologation activation lacks linked exchange evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_activation_exchanges_valid
  BEFORE INSERT ON fiscal_capability_activation_events
  FOR EACH ROW EXECUTE FUNCTION require_fiscal_homologation_activation_exchanges();
