-- A consultation is never an authorization resend. Keep the retry budget durable
-- across processes and reserve exhausted cases for manual reconciliation.
CREATE FUNCTION verify_fiscal_homologation_consultation_budget()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consultation_count integer;
BEGIN
  IF NEW.service NOT IN ('receipt', 'protocol') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'fiscal:homologation:consult:' || NEW.tenant_id::text || ':' || NEW.document_id::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_homologation_parsed_responses parsed
      ON parsed.tenant_id = exchange.tenant_id AND parsed.exchange_id = exchange.id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.document_id = NEW.document_id
      AND parsed.decision IN ('authorized', 'rejected', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'SEFAZ document already has a terminal homologation decision'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO consultation_count FROM fiscal_homologation_exchanges
    WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id
      AND service IN ('receipt', 'protocol');
  IF consultation_count >= 10 THEN
    RAISE EXCEPTION 'SEFAZ consultation budget exhausted; reconcile manually'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_homologation_consultation_budget_valid
  BEFORE INSERT ON fiscal_homologation_exchanges
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_consultation_budget();
