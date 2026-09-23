ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_kind_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_kind_check CHECK (kind IN (
  'xml', 'response', 'protocol', 'pdf',
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol'
));

ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_purpose_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_purpose_check CHECK (purpose IN (
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol'
));

CREATE FUNCTION verify_fiscal_homologation_artifact_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind LIKE 'homologation_%' AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents document
    WHERE document.tenant_id = NEW.tenant_id AND document.id = NEW.document_id
      AND document.environment = 'homologation'
  ) THEN
    RAISE EXCEPTION 'Homologation artifact requires a homologation document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_artifact_environment_valid
  BEFORE INSERT ON fiscal_artifacts FOR EACH ROW
  EXECUTE FUNCTION verify_fiscal_homologation_artifact_environment();

-- Keep pre-migration drill evidence readable while requiring typed artifacts
-- for all new exchanges.
CREATE OR REPLACE FUNCTION verify_fiscal_homologation_exchange_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row fiscal_homologation_drill_grants%ROWTYPE;
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO grant_row FROM fiscal_homologation_drill_grants
    WHERE tenant_id = NEW.tenant_id AND id = NEW.drill_grant_id;
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = grant_row.tenant_id AND id = grant_row.capability_id;
  IF grant_row.document_id <> NEW.document_id OR grant_row.expires_at <= now() OR
    grant_row.endpoint_digest <> NEW.endpoint_digest OR
    grant_row.wsdl_digest <> NEW.wsdl_digest OR
    grant_row.certificate_fingerprint <> NEW.certificate_fingerprint OR
    definition.adapter_version <> NEW.adapter_version THEN
    RAISE EXCEPTION 'SEFAZ exchange differs from approved drill grant'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_artifacts artifact
    WHERE artifact.tenant_id = NEW.tenant_id AND artifact.document_id = NEW.document_id
      AND artifact.kind = 'homologation_request' AND artifact.digest = NEW.request_digest
  ) THEN
    RAISE EXCEPTION 'Prepared SEFAZ request artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_raw_artifact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_artifacts artifact
      ON artifact.tenant_id = exchange.tenant_id
      AND artifact.document_id = exchange.document_id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id
      AND artifact.kind = 'homologation_response' AND artifact.digest = NEW.response_digest
  ) THEN
    RAISE EXCEPTION 'Raw SEFAZ response artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_parsed_digest()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.response_digest <> (
    SELECT response_digest FROM fiscal_homologation_raw_responses
    WHERE tenant_id = NEW.tenant_id AND exchange_id = NEW.exchange_id
  ) THEN
    RAISE EXCEPTION 'Parsed SEFAZ response differs from immutable raw response'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.protocol_digest IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_artifacts artifact
      ON artifact.tenant_id = exchange.tenant_id
      AND artifact.document_id = exchange.document_id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id
      AND artifact.kind = 'homologation_protocol' AND artifact.digest = NEW.protocol_digest
  ) THEN
    RAISE EXCEPTION 'SEFAZ protocol artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
