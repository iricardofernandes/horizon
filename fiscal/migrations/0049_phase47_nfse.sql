-- Phase 47: national NFS-e. A service is its own origin with a competence date; the
-- municipality decides through a versioned registry; the authority, not Horizon, makes
-- the NFS-e access key. Nothing here creates a stock or money effect.

-- A reviewed service fiscal profile revision per Catalog service item.
CREATE TABLE fiscal_service_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  national_tax_code text NOT NULL CHECK (national_tax_code ~ '^[0-9]{6}$'),
  nbs_code text NOT NULL CHECK (nbs_code ~ '^[0-9]{9}$'),
  municipal_tax_code text CHECK (length(municipal_tax_code) BETWEEN 1 AND 20),
  iss_taxation text NOT NULL CHECK (iss_taxation = '1'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  effective_from date NOT NULL,
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, revision)
);

-- A versioned import of the official adhesion list, and its review.
CREATE TABLE fiscal_nfse_registry_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_uri text NOT NULL CHECK (source_uri ~ '^https://'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  published_on date NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count > 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  imported_by text NOT NULL CHECK (length(imported_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_nfse_registry_version_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_nfse_registry_version_digest_key UNIQUE (tenant_id, digest)
);

CREATE TABLE fiscal_nfse_registry_entries (
  tenant_id uuid NOT NULL,
  version_id uuid NOT NULL,
  municipality_code text NOT NULL CHECK (municipality_code ~ '^[0-9]{7}$'),
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
  agreement text NOT NULL CHECK (agreement IN ('active', 'inactive')),
  national_environment boolean NOT NULL,
  national_issuer boolean NOT NULL,
  starts_on date,
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 300),
  PRIMARY KEY (tenant_id, version_id, municipality_code),
  FOREIGN KEY (tenant_id, version_id) REFERENCES fiscal_nfse_registry_versions (tenant_id, id)
);

CREATE TABLE fiscal_nfse_registry_reviews (
  tenant_id uuid NOT NULL,
  version_id uuid NOT NULL,
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  interpretation_digest text NOT NULL CHECK (interpretation_digest ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version_id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES fiscal_nfse_registry_versions (tenant_id, id)
);

-- A frozen service provision. The optional source key is the owner fact (a Phase K
-- contract period): one key maps to one origin.
CREATE TABLE fiscal_service_origins (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  establishment_id uuid NOT NULL,
  issuer_profile_revision integer NOT NULL CHECK (issuer_profile_revision > 0),
  recipient_party_id uuid NOT NULL,
  recipient_profile_revision integer NOT NULL CHECK (recipient_profile_revision > 0),
  service_item_id uuid NOT NULL,
  service_profile_revision integer NOT NULL CHECK (service_profile_revision > 0),
  municipality_code text NOT NULL CHECK (municipality_code ~ '^[0-9]{7}$'),
  competence_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'BRL'),
  source_module text CHECK (source_module ~ '^[a-z][a-z-]{1,39}$'),
  source_document_type text CHECK (source_document_type ~ '^[a-z][a-z-]{1,39}$'),
  source_id uuid,
  source_period text CHECK (source_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_service_origin_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_service_origin_source_complete CHECK (
    num_nonnulls(source_module, source_document_type, source_id, source_period) IN (0, 4)
  ),
  FOREIGN KEY (tenant_id, service_item_id, service_profile_revision)
    REFERENCES fiscal_service_profiles (tenant_id, item_id, revision)
);
CREATE UNIQUE INDEX fiscal_service_origin_source_key ON fiscal_service_origins
  (tenant_id, source_module, source_document_type, source_id, source_period)
  WHERE source_id IS NOT NULL;

CREATE TABLE fiscal_service_origin_idempotency (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  origin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, origin_id) REFERENCES fiscal_service_origins (tenant_id, id)
);

-- An NFS-e document comes only from a service origin, and a service origin only makes
-- NFS-e documents. A substitute points at the NFS-e it replaces.
ALTER TABLE fiscal_documents ADD COLUMN service_origin_id uuid;
ALTER TABLE fiscal_documents ADD COLUMN substitutes_document_id uuid;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_service_origin_fk
  FOREIGN KEY (tenant_id, service_origin_id) REFERENCES fiscal_service_origins (tenant_id, id);
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_substitutes_fk
  FOREIGN KEY (tenant_id, substitutes_document_id) REFERENCES fiscal_documents (tenant_id, id);
ALTER TABLE fiscal_documents DROP CONSTRAINT fiscal_document_origin_exactly_one;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_origin_exactly_one CHECK (
  num_nonnulls(intent_id, manual_origin_id, linked_origin_id, service_origin_id) = 1
);
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_nfse_service_origin CHECK (
  (model = 'nfse') = (service_origin_id IS NOT NULL)
);
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_substitution_nfse CHECK (
  substitutes_document_id IS NULL OR model = 'nfse'
);
CREATE UNIQUE INDEX fiscal_document_service_origin_active
  ON fiscal_documents (tenant_id, service_origin_id)
  WHERE service_origin_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');
CREATE UNIQUE INDEX fiscal_document_substitute_active
  ON fiscal_documents (tenant_id, substitutes_document_id)
  WHERE substitutes_document_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');

-- The reason a substitute DPS carries in its `subst` group (E0078: text for code 99).
CREATE TABLE fiscal_nfse_substitution_requests (
  tenant_id uuid NOT NULL,
  substitute_document_id uuid NOT NULL,
  original_document_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('01', '02', '03', '04', '05', '99')),
  reason text CHECK (length(reason) BETWEEN 15 AND 255),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, substitute_document_id),
  CONSTRAINT fiscal_nfse_substitution_request_reason CHECK (reason_code <> '99' OR reason IS NOT NULL),
  FOREIGN KEY (tenant_id, substitute_document_id) REFERENCES fiscal_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, original_document_id) REFERENCES fiscal_documents (tenant_id, id)
);

-- A substitute replaces an authorized NFS-e of the same establishment.
CREATE FUNCTION guard_fiscal_nfse_substitute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.substitutes_document_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_documents original
    WHERE original.tenant_id = NEW.tenant_id AND original.id = NEW.substitutes_document_id
      AND original.model = 'nfse' AND original.status = 'authorized'
      AND original.establishment_id = NEW.establishment_id
  ) THEN
    RAISE EXCEPTION 'An NFS-e substitute must replace an authorized NFS-e'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_documents_nfse_substitute BEFORE INSERT ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_nfse_substitute();

-- Before sending, an NFS-e is bound by its DPS identifier; the key comes back later.
ALTER TABLE fiscal_document_issuance_bindings
  DROP CONSTRAINT fiscal_document_issuance_bindings_access_key_check;
ALTER TABLE fiscal_document_issuance_bindings ADD CONSTRAINT
  fiscal_document_issuance_bindings_access_key_check CHECK (
    access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$' OR access_key ~ '^DPS[0-9]{42}$'
  );

-- What the national system generated: its key, number and processing instant.
CREATE TABLE fiscal_nfse_generations (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  command_id uuid NOT NULL,
  dps_id text NOT NULL CHECK (dps_id ~ '^DPS[0-9]{42}$'),
  nfse_key text NOT NULL CHECK (nfse_key ~ '^[0-9]{50}$'),
  nfse_number text NOT NULL CHECK (nfse_number ~ '^[1-9][0-9]{0,12}$'),
  processed_at timestamptz NOT NULL,
  nfse_xml_digest text NOT NULL CHECK (nfse_xml_digest ~ '^[0-9a-f]{64}$'),
  values_digest text NOT NULL CHECK (values_digest ~ '^[0-9a-f]{64}$'),
  calculation_matches boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fiscal_nfse_generation_key UNIQUE (tenant_id, nfse_key),
  CONSTRAINT fiscal_nfse_generation_dps UNIQUE (tenant_id, dps_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES fiscal_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES fiscal_dispatch_commands (tenant_id, id)
);

-- Event 105102: the substitute's generation cancelled the original, once.
CREATE TABLE fiscal_nfse_substitutions (
  tenant_id uuid NOT NULL,
  original_document_id uuid NOT NULL,
  substitute_document_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('01', '02', '03', '04', '05', '99')),
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, original_document_id),
  CONSTRAINT fiscal_nfse_substitution_substitute UNIQUE (tenant_id, substitute_document_id),
  FOREIGN KEY (tenant_id, original_document_id) REFERENCES fiscal_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, substitute_document_id) REFERENCES fiscal_documents (tenant_id, id)
);

CREATE FUNCTION guard_fiscal_nfse_substitution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_documents substitute
    WHERE substitute.tenant_id = NEW.tenant_id AND substitute.id = NEW.substitute_document_id
      AND substitute.substitutes_document_id = NEW.original_document_id
      AND substitute.status = 'authorized'
  ) THEN
    RAISE EXCEPTION 'A substitution needs the authorized substitute of that NFS-e'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_nfse_substitutions_guard BEFORE INSERT ON fiscal_nfse_substitutions
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_nfse_substitution();

-- An NFS-e with a live substitute cannot also be cancelled by event 101101.
CREATE FUNCTION guard_fiscal_nfse_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'cancellation' AND EXISTS (
    SELECT 1 FROM fiscal_documents substitute
    WHERE substitute.tenant_id = NEW.tenant_id
      AND substitute.substitutes_document_id = NEW.document_id
      AND substitute.status NOT IN ('rejected', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'An NFS-e being substituted cannot be cancelled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_dispatch_commands_nfse_cancellation BEFORE INSERT
  ON fiscal_dispatch_commands FOR EACH ROW EXECUTE FUNCTION guard_fiscal_nfse_cancellation();

-- The Phase 42 guard, plus one path: an authorized NFS-e becomes cancelled when its
-- substitution was recorded (event 105102), without a cancellation request.
CREATE OR REPLACE FUNCTION guard_fiscal_document_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fiscal document is immutable'; END IF;
  IF to_jsonb(NEW) - 'status' <> to_jsonb(OLD) - 'status' THEN
    RAISE EXCEPTION 'fiscal document facts are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'ready') OR
    (OLD.status = 'ready' AND NEW.status = 'queued') OR
    (OLD.status = 'queued' AND NEW.status = 'submitted') OR
    (OLD.status = 'submitted' AND NEW.status IN ('unknown', 'authorized', 'rejected')) OR
    (OLD.status = 'unknown' AND NEW.status IN ('authorized', 'rejected')) OR
    (OLD.status = 'authorized' AND NEW.status = 'cancellation_pending') OR
    (OLD.status = 'cancellation_pending' AND
      NEW.status IN ('authorized', 'cancelled', 'cancellation_unknown')) OR
    (OLD.status = 'cancellation_unknown' AND NEW.status IN ('authorized', 'cancelled')) OR
    (OLD.status = 'authorized' AND NEW.status = 'cancelled' AND NEW.model = 'nfse' AND
      EXISTS (
        SELECT 1 FROM fiscal_nfse_substitutions substitution
        WHERE substitution.tenant_id = NEW.tenant_id
          AND substitution.original_document_id = NEW.id
      ))
  ) THEN RAISE EXCEPTION 'invalid fiscal document transition'; END IF;
  IF NEW.status <> 'draft' AND NOT EXISTS (
    SELECT 1 FROM fiscal_document_calculation_bindings binding
    WHERE binding.tenant_id = NEW.tenant_id AND binding.document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fiscal document requires a supported calculation';
  END IF;
  IF NEW.status IN ('queued', 'submitted', 'unknown', 'authorized', 'rejected',
      'cancellation_pending', 'cancellation_unknown', 'cancelled') AND NOT EXISTS (
    SELECT 1 FROM fiscal_number_reservations reservation
    WHERE reservation.tenant_id = NEW.tenant_id AND reservation.document_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'fiscal document requires a reserved number';
  END IF;
  IF NEW.model = 'nfse' AND NEW.status = 'authorized' AND OLD.status IN ('submitted', 'unknown')
    AND NOT EXISTS (
      SELECT 1 FROM fiscal_nfse_generations generation
      WHERE generation.tenant_id = NEW.tenant_id AND generation.document_id = NEW.id
    ) THEN
    RAISE EXCEPTION 'an authorized NFS-e requires its generation record';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_kind_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_kind_check CHECK (kind IN (
  'xml', 'response', 'protocol', 'pdf',
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol',
  'correction_request', 'correction_response', 'correction_protocol',
  'nfse_xml', 'substitution_event'
));
ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_purpose_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_purpose_check CHECK (purpose IN (
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol',
  'correction_request', 'correction_response', 'correction_protocol',
  'nfse_xml', 'substitution_event'
));

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['fiscal_service_profiles', 'fiscal_nfse_registry_versions',
    'fiscal_nfse_registry_entries', 'fiscal_nfse_registry_reviews', 'fiscal_service_origins',
    'fiscal_service_origin_idempotency', 'fiscal_nfse_generations',
    'fiscal_nfse_substitutions', 'fiscal_nfse_substitution_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app
      USING (tenant_id = current_setting(''app.current_tenant'')::uuid)
      WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO horizon_app', name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation()', name || '_immutable', name);
  END LOOP;
END $$;
