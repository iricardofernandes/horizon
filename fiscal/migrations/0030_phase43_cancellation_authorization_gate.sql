-- Cancellation requires the exact protocol observed for an authorized document.
ALTER TABLE fiscal_homologation_exchanges
  ADD COLUMN authorization_protocol text,
  ADD CONSTRAINT fiscal_homologation_event_authorization_protocol CHECK (
    (service = 'event' AND authorization_protocol ~ '^[0-9]{15}$') OR
    (service <> 'event' AND authorization_protocol IS NULL)
  );

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_recovery_parent() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.service = 'event' AND NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges observed
    JOIN fiscal_homologation_parsed_responses parsed
      ON parsed.tenant_id = observed.tenant_id AND parsed.exchange_id = observed.id
    WHERE observed.tenant_id = NEW.tenant_id
      AND observed.document_id = NEW.document_id
      AND observed.access_key = NEW.access_key
      AND (observed.id = parent_row.id OR observed.parent_exchange_id = parent_row.id)
      AND observed.service IN ('authorization', 'receipt', 'protocol')
      AND parsed.document_cstat = '100'
      AND parsed.protocol_number = NEW.authorization_protocol
      AND (
        (observed.service = 'protocol' AND parsed.cstat = '100') OR
        (observed.service IN ('authorization', 'receipt') AND parsed.cstat = '104')
      )
  ) THEN
    RAISE EXCEPTION 'SEFAZ cancellation requires the exact authorized protocol'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
