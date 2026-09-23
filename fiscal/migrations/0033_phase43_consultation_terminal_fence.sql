-- Serialize terminal observations with consultation send markers. Network calls
-- remain outside the transaction; no lock is held during a SEFAZ request.
CREATE FUNCTION fence_fiscal_homologation_terminal_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_document uuid;
BEGIN
  IF NEW.decision NOT IN ('authorized', 'rejected', 'cancelled') THEN RETURN NEW; END IF;
  SELECT document_id INTO target_document FROM fiscal_homologation_exchanges
    WHERE tenant_id = NEW.tenant_id AND id = NEW.exchange_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'fiscal:homologation:consult:' || NEW.tenant_id::text || ':' || target_document::text, 0
  ));
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_homologation_terminal_observation_fence
  BEFORE INSERT ON fiscal_homologation_parsed_responses
  FOR EACH ROW EXECUTE FUNCTION fence_fiscal_homologation_terminal_observation();

CREATE FUNCTION fence_fiscal_homologation_consultation_send()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_document uuid;
DECLARE target_service text;
BEGIN
  SELECT document_id, service INTO target_document, target_service
    FROM fiscal_homologation_exchanges
    WHERE tenant_id = NEW.tenant_id AND id = NEW.exchange_id;
  IF target_service NOT IN ('receipt', 'protocol') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'fiscal:homologation:consult:' || NEW.tenant_id::text || ':' || target_document::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_homologation_parsed_responses parsed
      ON parsed.tenant_id = exchange.tenant_id AND parsed.exchange_id = exchange.id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.document_id = target_document
      AND parsed.decision IN ('authorized', 'rejected', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'SEFAZ document already has a terminal homologation decision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_homologation_consultation_send_fence
  BEFORE INSERT ON fiscal_homologation_transmissions
  FOR EACH ROW EXECUTE FUNCTION fence_fiscal_homologation_consultation_send();
