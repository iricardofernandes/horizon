ALTER TABLE fiscal_homologation_parsed_responses
  ADD COLUMN decision text NOT NULL DEFAULT 'unknown'
    CHECK (decision IN ('authorized', 'rejected', 'cancelled', 'pending',
      'available', 'unavailable', 'unknown')),
  ADD COLUMN decision_version text NOT NULL DEFAULT 'nfe55-sp-homologation-decision-v1'
    CHECK (decision_version = 'nfe55-sp-homologation-decision-v1');

CREATE FUNCTION verify_fiscal_homologation_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exchange_service text;
BEGIN
  SELECT service INTO exchange_service FROM fiscal_homologation_exchanges
    WHERE tenant_id = NEW.tenant_id AND id = NEW.exchange_id;
  IF exchange_service IS NULL THEN
    RAISE EXCEPTION 'SEFAZ exchange is missing for decision' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'authorized' AND NOT (
    ((exchange_service IN ('authorization', 'receipt') AND NEW.cstat = '104')
      OR (exchange_service = 'protocol' AND NEW.cstat = '100'))
    AND NEW.document_cstat = '100'
    AND NEW.protocol_number IS NOT NULL AND NEW.protocol_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Authorized decision lacks SEFAZ protocol evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'cancelled' AND NOT (
    exchange_service = 'event' AND NEW.cstat = '128' AND NEW.event_cstat = '135'
    AND NEW.protocol_number IS NOT NULL AND NEW.protocol_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cancelled decision lacks SEFAZ event evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'rejected' AND NOT (
    (exchange_service = 'authorization' AND NEW.cstat IN ('215', '225'))
    OR (exchange_service IN ('authorization', 'receipt') AND NEW.cstat = '104'
      AND NEW.document_cstat IN ('215', '225'))
  ) THEN
    RAISE EXCEPTION 'Rejected decision lacks reviewed SEFAZ code' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'pending' AND NOT (
    (exchange_service = 'authorization' AND NEW.cstat = '103' AND NEW.receipt IS NOT NULL)
    OR (exchange_service = 'receipt' AND NEW.cstat = '105')
  ) THEN
    RAISE EXCEPTION 'Pending decision lacks reviewed SEFAZ code' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'available' AND NOT (
    exchange_service = 'status' AND NEW.cstat = '107'
  ) THEN
    RAISE EXCEPTION 'Available decision lacks reviewed SEFAZ code' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'unavailable' AND NOT (
    exchange_service = 'status' AND NEW.cstat IN ('108', '109')
  ) THEN
    RAISE EXCEPTION 'Unavailable decision lacks reviewed SEFAZ code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_homologation_decision_valid
  BEFORE INSERT ON fiscal_homologation_parsed_responses
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_decision();
