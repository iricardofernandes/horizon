-- A new exchange id must never bypass the query-before-resend boundary.
CREATE UNIQUE INDEX fiscal_homologation_one_authorization_per_document
  ON fiscal_homologation_exchanges (tenant_id, document_id)
  WHERE service = 'authorization';
CREATE UNIQUE INDEX fiscal_homologation_one_cancellation_per_document
  ON fiscal_homologation_exchanges (tenant_id, document_id)
  WHERE service = 'event';

CREATE FUNCTION verify_fiscal_homologation_recovery_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_row fiscal_homologation_exchanges%ROWTYPE;
DECLARE accepted_receipt text;
BEGIN
  IF NEW.service IN ('authorization', 'status') THEN
    IF NEW.parent_exchange_id IS NOT NULL THEN
      RAISE EXCEPTION 'Root SEFAZ exchange cannot claim a parent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_exchange_id IS NULL THEN
    RAISE EXCEPTION 'SEFAZ consultation or event requires its authorization parent'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO parent_row FROM fiscal_homologation_exchanges
    WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_exchange_id;
  IF parent_row.service <> 'authorization' OR
    parent_row.document_id <> NEW.document_id OR
    parent_row.access_key <> NEW.access_key OR
    NOT EXISTS (
      SELECT 1 FROM fiscal_homologation_transmissions transmission
      WHERE transmission.tenant_id = NEW.tenant_id
        AND transmission.exchange_id = NEW.parent_exchange_id
    ) THEN
    RAISE EXCEPTION 'SEFAZ recovery does not match a started authorization'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.service = 'receipt' THEN
    SELECT receipt INTO accepted_receipt FROM fiscal_homologation_parsed_responses
      WHERE tenant_id = NEW.tenant_id AND exchange_id = NEW.parent_exchange_id;
    IF accepted_receipt IS NULL OR accepted_receipt <> NEW.receipt THEN
      RAISE EXCEPTION 'SEFAZ receipt differs from the recorded authorization'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_recovery_parent_valid
  BEFORE INSERT ON fiscal_homologation_exchanges
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_recovery_parent();
