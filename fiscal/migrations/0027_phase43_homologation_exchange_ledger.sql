-- Internal homologation drill ledger. A started exchange is always uncertain until
-- a response or consultation is recorded; retrying must never start it twice.
CREATE TABLE fiscal_homologation_drill_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  document_id uuid NOT NULL,
  endpoint_digest text NOT NULL CHECK (endpoint_digest ~ '^[0-9a-f]{64}$'),
  wsdl_digest text NOT NULL CHECK (wsdl_digest ~ '^[0-9a-f]{64}$'),
  certificate_fingerprint text NOT NULL CHECK (certificate_fingerprint ~ '^[0-9a-f]{64}$'),
  issued_by text NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_homologation_drill_tenant_id_key UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_drill_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
DECLARE document fiscal_documents%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  SELECT * INTO document FROM fiscal_documents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55' OR
    definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP' OR
    definition.operation <> 'normal-sale' OR document.environment <> 'homologation' OR
    document.model <> '55' OR document.establishment_id <> definition.establishment_id THEN
    RAISE EXCEPTION 'Homologation drill tuple differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_capability_reviews review
    WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
      AND review.approved AND review.reviewed_by <> NEW.issued_by
  ) THEN
    RAISE EXCEPTION 'Homologation drill requires an independent approved reviewer'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '2 hours' THEN
    RAISE EXCEPTION 'Homologation drill grant must expire within two hours'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_drill_grant_valid
  BEFORE INSERT ON fiscal_homologation_drill_grants
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_drill_grant();

CREATE TABLE fiscal_homologation_exchanges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  drill_grant_id uuid NOT NULL,
  parent_exchange_id uuid,
  service text NOT NULL CHECK (service IN ('authorization', 'receipt', 'protocol', 'status', 'event')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  endpoint_digest text NOT NULL CHECK (endpoint_digest ~ '^[0-9a-f]{64}$'),
  wsdl_digest text NOT NULL CHECK (wsdl_digest ~ '^[0-9a-f]{64}$'),
  certificate_fingerprint text NOT NULL CHECK (certificate_fingerprint ~ '^[0-9a-f]{64}$'),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 160),
  access_key text CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
  receipt text CHECK (receipt ~ '^[0-9]{15}$'),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_homologation_exchange_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_homologation_exchange_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  CONSTRAINT fiscal_homologation_exchange_drill_fk FOREIGN KEY (tenant_id, drill_grant_id)
    REFERENCES fiscal_homologation_drill_grants(tenant_id, id),
  CONSTRAINT fiscal_homologation_exchange_parent_fk FOREIGN KEY (tenant_id, parent_exchange_id)
    REFERENCES fiscal_homologation_exchanges(tenant_id, id),
  CONSTRAINT fiscal_homologation_exchange_correlation CHECK (
    (service = 'status' AND access_key IS NULL AND receipt IS NULL) OR
    (service = 'receipt' AND access_key IS NOT NULL AND receipt IS NOT NULL) OR
    (service IN ('authorization', 'protocol', 'event') AND access_key IS NOT NULL AND receipt IS NULL)
  )
);

CREATE FUNCTION verify_fiscal_homologation_exchange_grant() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND artifact.kind = 'xml' AND artifact.digest = NEW.request_digest
  ) THEN
    RAISE EXCEPTION 'Prepared SEFAZ request artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_exchange_grant_valid
  BEFORE INSERT ON fiscal_homologation_exchanges
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_exchange_grant();
CREATE INDEX fiscal_homologation_exchange_document_history ON fiscal_homologation_exchanges
  (tenant_id, document_id, prepared_at, id);

CREATE TABLE fiscal_homologation_transmissions (
  tenant_id uuid NOT NULL,
  exchange_id uuid NOT NULL,
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, exchange_id),
  FOREIGN KEY (tenant_id, exchange_id)
    REFERENCES fiscal_homologation_exchanges(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_transmission_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_homologation_drill_grants grant_row
      ON grant_row.tenant_id = exchange.tenant_id AND grant_row.id = exchange.drill_grant_id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id
      AND grant_row.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Homologation drill grant expired before transmission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_transmission_grant_valid
  BEFORE INSERT ON fiscal_homologation_transmissions
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_transmission_grant();

-- Raw bytes are kept encrypted in the artifact store. This row is written before
-- parsing, so a parser crash does not erase evidence that a response arrived.
CREATE TABLE fiscal_homologation_raw_responses (
  tenant_id uuid NOT NULL,
  exchange_id uuid NOT NULL,
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, exchange_id),
  FOREIGN KEY (tenant_id, exchange_id)
    REFERENCES fiscal_homologation_transmissions(tenant_id, exchange_id)
);

CREATE FUNCTION verify_fiscal_homologation_raw_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_exchanges exchange
    JOIN fiscal_artifacts artifact
      ON artifact.tenant_id = exchange.tenant_id
      AND artifact.document_id = exchange.document_id
    WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id
      AND artifact.kind = 'response' AND artifact.digest = NEW.response_digest
  ) THEN
    RAISE EXCEPTION 'Raw SEFAZ response artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_raw_artifact_valid
  BEFORE INSERT ON fiscal_homologation_raw_responses
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_raw_artifact();

CREATE TABLE fiscal_homologation_parsed_responses (
  tenant_id uuid NOT NULL,
  exchange_id uuid NOT NULL,
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  protocol_digest text CHECK (protocol_digest ~ '^[0-9a-f]{64}$'),
  cstat text NOT NULL CHECK (cstat ~ '^[0-9]{3}$'),
  document_cstat text CHECK (document_cstat ~ '^[0-9]{3}$'),
  event_cstat text CHECK (event_cstat ~ '^[0-9]{3}$'),
  receipt text CHECK (receipt ~ '^[0-9]{15}$'),
  protocol_number text CHECK (protocol_number ~ '^[0-9]{15}$'),
  parsed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, exchange_id),
  FOREIGN KEY (tenant_id, exchange_id)
    REFERENCES fiscal_homologation_raw_responses(tenant_id, exchange_id)
);

CREATE FUNCTION verify_fiscal_homologation_parsed_digest() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND artifact.kind = 'protocol' AND artifact.digest = NEW.protocol_digest
  ) THEN
    RAISE EXCEPTION 'SEFAZ protocol artifact is missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_parsed_digest_valid
  BEFORE INSERT ON fiscal_homologation_parsed_responses
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_parsed_digest();

ALTER TABLE fiscal_homologation_drill_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_drill_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_exchanges FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_transmissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_transmissions FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_raw_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_raw_responses FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_parsed_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_parsed_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_drill_grants TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON fiscal_homologation_exchanges TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON fiscal_homologation_transmissions TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON fiscal_homologation_raw_responses TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON fiscal_homologation_parsed_responses TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_drill_grants, fiscal_homologation_exchanges,
  fiscal_homologation_transmissions,
  fiscal_homologation_raw_responses, fiscal_homologation_parsed_responses TO horizon_app;
CREATE TRIGGER fiscal_homologation_drill_grants_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_drill_grants FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_homologation_exchanges_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_exchanges FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_homologation_transmissions_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_transmissions FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_homologation_raw_responses_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_raw_responses FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_homologation_parsed_responses_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_parsed_responses FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
