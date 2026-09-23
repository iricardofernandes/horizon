-- An authorization envelope must be the one bound to this document's signed
-- NF-e, reviewed capability, credential and reserved homologation number.
CREATE TABLE fiscal_homologation_authorization_bindings (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  drill_grant_id uuid NOT NULL,
  access_key text NOT NULL CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
  number bigint NOT NULL CHECK (number BETWEEN 1 AND 999999999),
  signed_xml_digest text NOT NULL CHECK (signed_xml_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, drill_grant_id)
    REFERENCES fiscal_homologation_drill_grants(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_authorization_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document_row fiscal_documents%ROWTYPE;
DECLARE grant_row fiscal_homologation_drill_grants%ROWTYPE;
DECLARE reservation fiscal_number_reservations%ROWTYPE;
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO document_row FROM fiscal_documents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;
  SELECT * INTO grant_row FROM fiscal_homologation_drill_grants
    WHERE tenant_id = NEW.tenant_id AND id = NEW.drill_grant_id;
  SELECT * INTO reservation FROM fiscal_number_reservations
    WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id;
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = grant_row.capability_id;
  IF reservation.document_id IS NULL
    OR document_row.environment <> 'homologation' OR document_row.model <> '55'
    OR grant_row.document_id <> NEW.document_id OR grant_row.expires_at <= now()
    OR reservation.homologation_grant_id <> NEW.drill_grant_id
    OR reservation.number <> NEW.number
    OR definition.schema_package_digest <> NEW.schema_digest
    OR substr(NEW.access_key, 1, 2) <> '35'
    OR substr(NEW.access_key, 21, 2) <> '55'
    OR substr(NEW.access_key, 23, 3)::integer <> document_row.series
    OR substr(NEW.access_key, 26, 9)::bigint <> NEW.number THEN
    RAISE EXCEPTION 'Homologation authorization binding differs from document, drill or number'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_artifacts artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.document_id = NEW.document_id
      AND artifact.kind = 'homologation_request'
      AND artifact.digest = NEW.signed_xml_digest
      AND artifact.source_schema = 'sefaz-nfe400-signed-document:' || NEW.schema_digest
  ) OR NOT EXISTS (
    SELECT 1 FROM fiscal_artifacts artifact
    WHERE artifact.tenant_id = NEW.tenant_id
      AND artifact.document_id = NEW.document_id
      AND artifact.kind = 'homologation_request'
      AND artifact.digest = NEW.request_digest
      AND artifact.source_schema = 'sefaz-nfe400-soap12-request'
  ) THEN
    RAISE EXCEPTION 'Homologation authorization binding lacks immutable request artifacts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_authorization_binding_valid
  BEFORE INSERT ON fiscal_homologation_authorization_bindings
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_authorization_binding();

ALTER TABLE fiscal_homologation_authorization_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_authorization_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_authorization_bindings TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_authorization_bindings TO horizon_app;
CREATE TRIGGER fiscal_homologation_authorization_bindings_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_authorization_bindings FOR EACH ROW
  EXECUTE FUNCTION reject_fiscal_immutable_mutation();

CREATE FUNCTION verify_fiscal_homologation_authorization_exchange()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.service <> 'authorization' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_authorization_bindings binding
    WHERE binding.tenant_id = NEW.tenant_id
      AND binding.document_id = NEW.document_id
      AND binding.drill_grant_id = NEW.drill_grant_id
      AND binding.access_key = NEW.access_key
      AND binding.request_digest = NEW.request_digest
  ) THEN
    RAISE EXCEPTION 'SEFAZ authorization requires the bound signed document and envelope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_authorization_exchange_valid
  BEFORE INSERT ON fiscal_homologation_exchanges
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_authorization_exchange();
