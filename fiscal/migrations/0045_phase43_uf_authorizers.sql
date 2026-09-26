-- NF-e homologation follows the issuer's UF instead of a fixed SP tuple. The UF
-- selects the authorizer (own SEFAZ, SVRS or SVAN) in the application; the database
-- keeps each tuple internally consistent: a capability names a real UF, and an
-- access key starts with that UF's IBGE code.
CREATE FUNCTION fiscal_nfe_uf_code(uf text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE uf
    WHEN 'RO' THEN '11' WHEN 'AC' THEN '12' WHEN 'AM' THEN '13' WHEN 'RR' THEN '14'
    WHEN 'PA' THEN '15' WHEN 'AP' THEN '16' WHEN 'TO' THEN '17' WHEN 'MA' THEN '21'
    WHEN 'PI' THEN '22' WHEN 'CE' THEN '23' WHEN 'RN' THEN '24' WHEN 'PB' THEN '25'
    WHEN 'PE' THEN '26' WHEN 'AL' THEN '27' WHEN 'SE' THEN '28' WHEN 'BA' THEN '29'
    WHEN 'MG' THEN '31' WHEN 'ES' THEN '32' WHEN 'RJ' THEN '33' WHEN 'SP' THEN '35'
    WHEN 'PR' THEN '41' WHEN 'SC' THEN '42' WHEN 'RS' THEN '43' WHEN 'MS' THEN '50'
    WHEN 'MT' THEN '51' WHEN 'GO' THEN '52' WHEN 'DF' THEN '53'
  END
$$;

ALTER TABLE fiscal_capability_definitions
  ADD CONSTRAINT fiscal_capability_nfe_uf_valid CHECK (
    model NOT IN ('55', '65') OR fiscal_nfe_uf_code(jurisdiction_code) IS NOT NULL
  );

-- An emulated authorizer reuses the official request bytes over a loopback route.
-- Its exchanges are real ledger entries, but they can never become the evidence
-- that activates a homologated capability.
ALTER TABLE fiscal_homologation_drill_grants
  ADD COLUMN authority text NOT NULL DEFAULT 'official'
    CHECK (authority IN ('official', 'emulated'));

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_drill_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
DECLARE document fiscal_documents%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  SELECT * INTO document FROM fiscal_documents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55' OR
    definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL OR
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

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_number_range()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
    OR definition.operation <> 'normal-sale'
    OR definition.establishment_id <> NEW.establishment_id THEN
    RAISE EXCEPTION 'Homologation number range differs from reviewed tuple'
      USING ERRCODE = '23514';
  END IF;
  IF definition.created_by = NEW.reviewed_by OR NOT EXISTS (
    SELECT 1 FROM fiscal_capability_reviews review
    WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
      AND review.approved AND review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'Homologation number range requires independent capability reviewer'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_number_ranges existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.establishment_id = NEW.establishment_id
      AND existing.series = NEW.series
  ) AND EXISTS (
    SELECT 1 FROM fiscal_number_counters counter
    WHERE counter.tenant_id = NEW.tenant_id
      AND counter.establishment_id = NEW.establishment_id
      AND counter.environment = 'homologation' AND counter.model = '55'
      AND counter.series = NEW.series
  ) THEN
    RAISE EXCEPTION 'Homologation number counter exists before reviewed range'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_authorization_binding()
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
    OR substr(NEW.access_key, 1, 2) IS DISTINCT FROM fiscal_nfe_uf_code(definition.jurisdiction_code)
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

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_calculation_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
DECLARE expected_digest text;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.calculation_fixture_id <> NEW.calculation_fixture_id
    OR definition.created_by = NEW.reviewed_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation calculation approval differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.package_digests <> (
    SELECT array_agg(candidate ORDER BY candidate)
    FROM (SELECT DISTINCT candidate
      FROM unnest(NEW.package_digests) AS digest(candidate)) sorted
  ) THEN
    RAISE EXCEPTION 'Homologation calculation packages must be sorted and unique'
      USING ERRCODE = '23514';
  END IF;
  FOREACH expected_digest IN ARRAY NEW.package_digests LOOP
    IF expected_digest !~ '^[0-9a-f]{64}$' OR NOT EXISTS (
      SELECT 1 FROM fiscal_source_packages package
      JOIN fiscal_package_reviews review
        ON review.tenant_id = package.tenant_id AND review.package_id = package.id
      WHERE package.tenant_id = NEW.tenant_id
        AND package.package_digest = expected_digest
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
        AND NEW.calculation_fixture_id = ANY(review.fixture_ids)
    ) THEN
      RAISE EXCEPTION 'Homologation calculation package lacks matching independent review'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_issuance_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.created_by = NEW.reviewed_by
    OR (NEW.profile->>'capabilityId') IS DISTINCT FROM NEW.capability_id::text
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation issuance profile differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_event_schema_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.created_by = NEW.reviewed_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation event schema differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_source_packages package
    JOIN fiscal_source_payloads payload
      ON payload.tenant_id = package.tenant_id AND payload.package_id = package.id
    JOIN fiscal_package_reviews review
      ON review.tenant_id = package.tenant_id AND review.package_id = package.id
    WHERE package.tenant_id = NEW.tenant_id
      AND package.package_digest = NEW.schema_digest
      AND payload.byte_size = octet_length(payload.source_bytes)
      AND review.approved AND review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'Homologation event schema lacks retained reviewed bytes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_fiscal_homologation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
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
        AND grant_row.authority = 'official'
        AND auth_exchange.endpoint_digest = NEW.endpoint_set_digest
        AND auth_exchange.certificate_fingerprint = NEW.certificate_fingerprint
  ) THEN
    RAISE EXCEPTION 'homologation evidence lacks linked authorized consultation and cancellation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION verify_fiscal_homologation_response_schema_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR fiscal_nfe_uf_code(definition.jurisdiction_code) IS NULL
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.created_by = NEW.reviewed_by
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation response schemas differ from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES (NEW.document_schema_digest), (NEW.consultation_schema_digest)) AS selected(digest)
    WHERE NOT EXISTS (
      SELECT 1 FROM fiscal_source_packages package
      JOIN fiscal_source_payloads payload
        ON payload.tenant_id = package.tenant_id AND payload.package_id = package.id
      JOIN fiscal_package_reviews review
        ON review.tenant_id = package.tenant_id AND review.package_id = package.id
      WHERE package.tenant_id = NEW.tenant_id AND package.package_digest = selected.digest
        AND payload.byte_size = octet_length(payload.source_bytes)
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    )
  ) THEN
    RAISE EXCEPTION 'Homologation response schemas lack retained reviewed bytes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
