-- A homologation PDF must be visibly distinct from the simulation artifact and
-- can only be retained after an actual authorized protocol observation.
CREATE FUNCTION verify_fiscal_homologation_danfe()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document_environment text;
BEGIN
  IF NEW.kind <> 'danfe' THEN RETURN NEW; END IF;
  SELECT environment INTO document_environment FROM fiscal_documents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;
  IF document_environment <> 'homologation' THEN
    IF NEW.source_schema = 'horizon-danfe-homologation-v1' THEN
      RAISE EXCEPTION 'Homologation DANFE requires a homologation document'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.media_type <> 'application/pdf'
    OR NEW.source_schema <> 'horizon-danfe-homologation-v1'
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_homologation_exchanges exchange
      JOIN fiscal_homologation_parsed_responses parsed
        ON parsed.tenant_id = exchange.tenant_id AND parsed.exchange_id = exchange.id
      WHERE exchange.tenant_id = NEW.tenant_id
        AND exchange.document_id = NEW.document_id
        AND exchange.service IN ('authorization', 'receipt', 'protocol')
        AND parsed.decision = 'authorized'
        AND parsed.protocol_digest IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'Homologation DANFE requires an authorized protocol and distinct label'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_danfe_valid
  BEFORE INSERT ON fiscal_artifacts
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_danfe();
