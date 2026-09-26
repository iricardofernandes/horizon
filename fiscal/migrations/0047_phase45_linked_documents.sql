-- Phase 45: documents that return or complement an authorized original, and the model 55
-- correction letter. Fiscal still publishes no stock or money effect.

-- Phase 44 keyed an allocation by invoice line and order line only. Two partial receipts
-- of the same order line repeat that line id, so one invoice line could not be allocated
-- to both: the receipt belongs in the key.
ALTER TABLE fiscal_inbound_reconciliation_lines
  DROP CONSTRAINT fiscal_inbound_reconciliation_lines_pkey;
ALTER TABLE fiscal_inbound_reconciliation_lines ADD CONSTRAINT fiscal_inbound_reconciliation_lines_pkey
  PRIMARY KEY (tenant_id, reconciliation_id, line_number, receipt_id, receipt_line_id);

CREATE TABLE fiscal_linked_origins (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('sale-return', 'purchase-return', 'value-complement')),
  source_module text NOT NULL CHECK (source_module IN ('sales', 'procurement', 'fiscal')),
  -- The Sales return intent or the Procurement receipt; a reviewed complement has none.
  source_id uuid,
  -- The id Inventory and Financial key their own effects by (shipment or receipt).
  correlation_id uuid,
  establishment_id uuid NOT NULL,
  recipient_party_id uuid NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason_digest text CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_linked_origin_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_linked_origin_source CHECK (
    (kind = 'sale-return' AND source_module = 'sales' AND source_id IS NOT NULL
      AND correlation_id IS NOT NULL) OR
    (kind = 'purchase-return' AND source_module = 'procurement' AND source_id IS NOT NULL
      AND correlation_id IS NOT NULL) OR
    (kind = 'value-complement' AND source_module = 'fiscal' AND source_id IS NULL
      AND reason_digest IS NOT NULL)
  )
);
CREATE UNIQUE INDEX fiscal_linked_origin_source_key
  ON fiscal_linked_origins (tenant_id, kind, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE fiscal_linked_origin_idempotency (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  linked_origin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, linked_origin_id) REFERENCES fiscal_linked_origins (tenant_id, id)
);

CREATE TABLE fiscal_linked_references (
  tenant_id uuid NOT NULL,
  linked_origin_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 999),
  referenced_document_id uuid,
  referenced_import_id uuid,
  PRIMARY KEY (tenant_id, linked_origin_id, position),
  FOREIGN KEY (tenant_id, linked_origin_id) REFERENCES fiscal_linked_origins (tenant_id, id),
  FOREIGN KEY (tenant_id, referenced_document_id) REFERENCES fiscal_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, referenced_import_id) REFERENCES fiscal_inbound_documents (tenant_id, id),
  CONSTRAINT fiscal_linked_reference_one CHECK (
    (referenced_document_id IS NULL) <> (referenced_import_id IS NULL)
  )
);
CREATE INDEX fiscal_linked_references_document
  ON fiscal_linked_references (tenant_id, referenced_document_id)
  WHERE referenced_document_id IS NOT NULL;

CREATE TABLE fiscal_linked_origin_lines (
  tenant_id uuid NOT NULL,
  linked_origin_id uuid NOT NULL,
  line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  -- `document:<id>:<lineId>` or `import:<id>:<lineNumber>`: the original line.
  reference_key text NOT NULL CHECK (reference_key ~ '^(document|import):[0-9a-f-]{36}:[0-9a-f-]+$'),
  -- What the original line holds; null when only a value is complemented.
  reference_quantity numeric(18, 6) CHECK (reference_quantity > 0),
  quantity numeric(18, 6) NOT NULL CHECK (quantity >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (tenant_id, linked_origin_id, line_id, reference_key),
  FOREIGN KEY (tenant_id, linked_origin_id) REFERENCES fiscal_linked_origins (tenant_id, id)
);
CREATE INDEX fiscal_linked_origin_lines_reference
  ON fiscal_linked_origin_lines (tenant_id, reference_key);

ALTER TABLE fiscal_documents ADD COLUMN linked_origin_id uuid;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_linked_origin_fk
  FOREIGN KEY (tenant_id, linked_origin_id) REFERENCES fiscal_linked_origins (tenant_id, id);
ALTER TABLE fiscal_documents DROP CONSTRAINT fiscal_document_origin_exactly_one;
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_origin_exactly_one CHECK (
  num_nonnulls(intent_id, manual_origin_id, linked_origin_id) = 1
);
CREATE UNIQUE INDEX fiscal_document_linked_origin_active
  ON fiscal_documents (tenant_id, linked_origin_id)
  WHERE linked_origin_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');

-- A linked origin stops holding quantities only once its latest document is cancelled.
CREATE FUNCTION fiscal_linked_origin_void(p_tenant uuid, p_origin uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT document.status = 'cancelled' FROM fiscal_documents document
    WHERE document.tenant_id = p_tenant AND document.linked_origin_id = p_origin
    ORDER BY document.revision DESC LIMIT 1
  ), false)
$$;

CREATE FUNCTION guard_fiscal_linked_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held numeric(18, 6);
  other_reference numeric(18, 6);
BEGIN
  IF NEW.reference_quantity IS NULL THEN
    IF NEW.quantity <> 0 THEN
      RAISE EXCEPTION 'A value-only linked line carries no quantity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':' || NEW.reference_key, 45));
  SELECT line.reference_quantity INTO other_reference FROM fiscal_linked_origin_lines line
    WHERE line.tenant_id = NEW.tenant_id AND line.reference_key = NEW.reference_key
      AND line.reference_quantity IS DISTINCT FROM NEW.reference_quantity
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Linked reference quantity differs for the same original line'
      USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(line.quantity), 0) INTO held FROM fiscal_linked_origin_lines line
    WHERE line.tenant_id = NEW.tenant_id AND line.reference_key = NEW.reference_key
      AND NOT fiscal_linked_origin_void(line.tenant_id, line.linked_origin_id);
  IF held + NEW.quantity > NEW.reference_quantity THEN
    RAISE EXCEPTION 'Linked quantity exceeds the original line' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_linked_origin_lines_conservation BEFORE INSERT ON fiscal_linked_origin_lines
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_linked_conservation();

CREATE FUNCTION guard_fiscal_linked_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referenced_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents document
    WHERE document.tenant_id = NEW.tenant_id AND document.id = NEW.referenced_document_id
      AND document.status = 'authorized' AND document.linked_origin_id IS NULL
  ) THEN
    RAISE EXCEPTION 'A linked document must reference an authorized original'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_linked_references_authorized BEFORE INSERT ON fiscal_linked_references
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_linked_reference();

CREATE TABLE fiscal_correction_letters (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 20),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  text_digest text NOT NULL CHECK (text_digest ~ '^[0-9a-f]{64}$'),
  event_xml_digest text NOT NULL CHECK (event_xml_digest ~ '^[0-9a-f]{64}$'),
  attestation boolean NOT NULL CHECK (attestation),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done')),
  lease_owner text,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_correction_letter_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_correction_letter_sequence UNIQUE (tenant_id, document_id, sequence),
  CONSTRAINT fiscal_correction_letter_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fiscal_correction_letter_document_fk FOREIGN KEY (tenant_id, document_id)
    REFERENCES fiscal_documents (tenant_id, id),
  CONSTRAINT fiscal_correction_letter_lease CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR
    (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX fiscal_correction_letters_due ON fiscal_correction_letters
  (next_attempt_at, tenant_id, id) WHERE state <> 'done';

CREATE TABLE fiscal_correction_letter_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  letter_id uuid NOT NULL,
  observation_kind text NOT NULL CHECK (observation_kind IN ('response', 'consultation')),
  outcome text NOT NULL CHECK (outcome IN ('registered', 'rejected', 'unknown')),
  provider_correlation text CHECK (length(provider_correlation) BETWEEN 1 AND 256),
  response_digest text NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  protocol_digest text CHECK (protocol_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_correction_observation_identity UNIQUE
    (tenant_id, letter_id, observation_kind, response_digest),
  CONSTRAINT fiscal_correction_observation_letter_fk FOREIGN KEY (tenant_id, letter_id)
    REFERENCES fiscal_correction_letters (tenant_id, id)
);
CREATE UNIQUE INDEX fiscal_correction_final_once ON fiscal_correction_letter_observations
  (tenant_id, letter_id) WHERE outcome IN ('registered', 'rejected');

CREATE FUNCTION guard_fiscal_correction_letter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fiscal correction letter is immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM fiscal_documents document
      WHERE document.tenant_id = NEW.tenant_id AND document.id = NEW.document_id
        AND document.status = 'authorized' AND document.model = '55'
        AND document.environment = 'simulation'
    ) THEN
      RAISE EXCEPTION 'A correction letter needs an authorized simulated NF-e model 55'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - ARRAY['state', 'lease_owner', 'lease_until', 'attempt_count',
      'next_attempt_at', 'updated_at'] <>
     to_jsonb(OLD) - ARRAY['state', 'lease_owner', 'lease_until', 'attempt_count',
      'next_attempt_at', 'updated_at'] THEN
    RAISE EXCEPTION 'fiscal correction letter facts are immutable';
  END IF;
  IF OLD.state = 'done' AND NEW.state <> 'done' THEN
    RAISE EXCEPTION 'a resolved correction letter cannot reopen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_correction_letters_guard BEFORE INSERT OR UPDATE OR DELETE
  ON fiscal_correction_letters FOR EACH ROW EXECUTE FUNCTION guard_fiscal_correction_letter();

-- Cancelling an original that a live linked document or an unresolved letter still points
-- at would leave that document referring to nothing.
CREATE FUNCTION guard_fiscal_cancellation_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'cancellation' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM fiscal_linked_references reference
    WHERE reference.tenant_id = NEW.tenant_id
      AND reference.referenced_document_id = NEW.document_id
      AND NOT fiscal_linked_origin_void(reference.tenant_id, reference.linked_origin_id)
  ) THEN
    RAISE EXCEPTION 'Fiscal cancellation is blocked by linked documents' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fiscal_correction_letters letter
    WHERE letter.tenant_id = NEW.tenant_id AND letter.document_id = NEW.document_id
      AND letter.state <> 'done'
  ) THEN
    RAISE EXCEPTION 'Fiscal cancellation is blocked by an unresolved correction letter'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_dispatch_commands_cancellation_links BEFORE INSERT
  ON fiscal_dispatch_commands FOR EACH ROW EXECUTE FUNCTION guard_fiscal_cancellation_links();

ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_kind_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_kind_check CHECK (kind IN (
  'xml', 'response', 'protocol', 'pdf',
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol',
  'correction_request', 'correction_response', 'correction_protocol'
));
ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_purpose_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_purpose_check CHECK (purpose IN (
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe',
  'homologation_request', 'homologation_response', 'homologation_protocol',
  'correction_request', 'correction_response', 'correction_protocol'
));

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['fiscal_linked_origins', 'fiscal_linked_origin_idempotency',
    'fiscal_linked_references', 'fiscal_linked_origin_lines', 'fiscal_correction_letters',
    'fiscal_correction_letter_observations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app
      USING (tenant_id = current_setting(''app.current_tenant'')::uuid)
      WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO horizon_app', name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['fiscal_linked_origins', 'fiscal_linked_origin_idempotency',
    'fiscal_linked_references', 'fiscal_linked_origin_lines',
    'fiscal_correction_letter_observations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation()', name || '_immutable', name);
  END LOOP;
END $$;
GRANT UPDATE (state, lease_owner, lease_until, attempt_count, next_attempt_at, updated_at)
  ON fiscal_correction_letters TO horizon_app;
