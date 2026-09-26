-- Phase 44: supplier NF-e imports reconciled with Procurement receipts and Financial payables.

-- The Phase 40 placeholders never held data; refuse to drop them if a deployment wrote any.
ALTER TABLE fiscal_imports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_matches NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_imports) OR EXISTS (SELECT 1 FROM inbound_matches) THEN
    RAISE EXCEPTION 'Phase 40 inbound placeholders hold rows; migrate them before Phase 44';
  END IF;
END $$;
DROP TABLE inbound_matches;
DROP TABLE fiscal_imports;

CREATE TABLE fiscal_party_tax_index (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  party_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  tax_id_digest text NOT NULL CHECK (tax_id_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, party_id)
);
CREATE INDEX fiscal_party_tax_index_digest ON fiscal_party_tax_index (tenant_id, tax_id_digest);

CREATE TABLE fiscal_purchase_order_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (tenant_id, order_id, line_id)
);

CREATE TABLE fiscal_purchase_receipts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  received_on date NOT NULL,
  value_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  PRIMARY KEY (tenant_id, receipt_id)
);
CREATE INDEX fiscal_purchase_receipts_supplier
  ON fiscal_purchase_receipts (tenant_id, supplier_id, received_on);

CREATE TABLE fiscal_purchase_receipt_lines (
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  line_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  returned_quantity numeric(18, 6) NOT NULL DEFAULT 0
    CHECK (returned_quantity >= 0 AND returned_quantity <= quantity),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (tenant_id, receipt_id, line_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES fiscal_purchase_receipts (tenant_id, receipt_id)
);

CREATE TABLE fiscal_purchase_payables (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  title_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  party_id uuid NOT NULL,
  total_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  posted_at timestamptz NOT NULL,
  reversed_at timestamptz,
  PRIMARY KEY (tenant_id, title_id)
);
CREATE INDEX fiscal_purchase_payables_receipt ON fiscal_purchase_payables (tenant_id, receipt_id);

CREATE TABLE fiscal_inbound_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  access_key text NOT NULL CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
  series integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  number integer NOT NULL CHECK (number BETWEEN 1 AND 999999999),
  issued_at text NOT NULL,
  authority_environment text NOT NULL CHECK (authority_environment IN ('production', 'homologation')),
  issuer_tax_digest text NOT NULL CHECK (issuer_tax_digest ~ '^[0-9a-f]{64}$'),
  invoice_total_minor bigint NOT NULL CHECK (invoice_total_minor >= 0),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 990),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  verification jsonb NOT NULL CHECK (jsonb_typeof(verification) = 'object'),
  snapshot bytea NOT NULL,
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_inbound_document_key UNIQUE (tenant_id, access_key),
  CONSTRAINT fiscal_inbound_document_tenant_id UNIQUE (tenant_id, id)
);
CREATE INDEX fiscal_inbound_documents_page ON fiscal_inbound_documents (tenant_id, imported_at, id);

CREATE TABLE fiscal_inbound_conflicts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  import_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  received_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_inbound_conflict_bytes UNIQUE (tenant_id, import_id, source_digest),
  CONSTRAINT fiscal_inbound_conflict_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES fiscal_inbound_documents (tenant_id, id)
);

CREATE TABLE fiscal_inbound_conflict_dismissals (
  tenant_id uuid NOT NULL,
  conflict_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  dismissed_by text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conflict_id),
  FOREIGN KEY (tenant_id, conflict_id) REFERENCES fiscal_inbound_conflicts (tenant_id, id)
);

CREATE TABLE fiscal_supplier_item_mappings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  supplier_party_id uuid NOT NULL,
  product_code text NOT NULL CHECK (length(product_code) BETWEEN 1 AND 60),
  version integer NOT NULL CHECK (version > 0),
  item_id uuid NOT NULL,
  factor numeric(18, 6) NOT NULL CHECK (factor > 0),
  reconciliation_id uuid NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, supplier_party_id, product_code, version)
);

CREATE TABLE fiscal_inbound_reconciliations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  import_id uuid NOT NULL,
  supplier_party_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('matched', 'overridden')),
  override_reason text CHECK (override_reason IS NULL OR length(btrim(override_reason)) BETWEEN 10 AND 500),
  comparison jsonb NOT NULL CHECK (jsonb_typeof(comparison) = 'object'),
  comparison_digest text NOT NULL CHECK (comparison_digest ~ '^[0-9a-f]{64}$'),
  receipts jsonb NOT NULL CHECK (jsonb_typeof(receipts) = 'array' AND jsonb_array_length(receipts) > 0),
  payable_title_ids jsonb NOT NULL CHECK (jsonb_typeof(payable_title_ids) = 'array'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_inbound_reconciliation_decision
    CHECK ((decision = 'overridden') = (override_reason IS NOT NULL)),
  CONSTRAINT fiscal_inbound_reconciliation_import UNIQUE (tenant_id, import_id),
  CONSTRAINT fiscal_inbound_reconciliation_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fiscal_inbound_reconciliation_tenant_id UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES fiscal_inbound_documents (tenant_id, id)
);

CREATE TABLE fiscal_inbound_reconciliation_lines (
  tenant_id uuid NOT NULL,
  reconciliation_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 990),
  receipt_id uuid NOT NULL,
  receipt_line_id uuid NOT NULL,
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, reconciliation_id, line_number, receipt_line_id),
  FOREIGN KEY (tenant_id, reconciliation_id)
    REFERENCES fiscal_inbound_reconciliations (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id, receipt_line_id)
    REFERENCES fiscal_purchase_receipt_lines (tenant_id, receipt_id, line_id)
);
CREATE INDEX fiscal_inbound_reconciliation_lines_receipt
  ON fiscal_inbound_reconciliation_lines (tenant_id, receipt_id, receipt_line_id);

-- A reconciliation never proceeds while a conflicting duplicate is undismissed.
CREATE FUNCTION guard_fiscal_inbound_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM fiscal_inbound_conflicts c
    WHERE c.tenant_id = NEW.tenant_id AND c.import_id = NEW.import_id
      AND NOT EXISTS (
        SELECT 1 FROM fiscal_inbound_conflict_dismissals d
        WHERE d.tenant_id = c.tenant_id AND d.conflict_id = c.id)
  ) THEN
    RAISE EXCEPTION 'Supplier NF-e has an undismissed conflicting duplicate' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_inbound_reconciliation_guard BEFORE INSERT ON fiscal_inbound_reconciliations
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_inbound_reconciliation();

-- Allocations across every reconciliation never exceed what arrived and was not returned.
CREATE FUNCTION guard_fiscal_inbound_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_row fiscal_purchase_receipt_lines%ROWTYPE;
  allocated numeric(18, 6);
BEGIN
  SELECT * INTO line_row FROM fiscal_purchase_receipt_lines
    WHERE tenant_id = NEW.tenant_id AND receipt_id = NEW.receipt_id AND line_id = NEW.receipt_line_id
    FOR UPDATE;
  SELECT coalesce(sum(quantity), 0) INTO allocated FROM fiscal_inbound_reconciliation_lines
    WHERE tenant_id = NEW.tenant_id AND receipt_id = NEW.receipt_id
      AND receipt_line_id = NEW.receipt_line_id;
  IF allocated + NEW.quantity > line_row.quantity - line_row.returned_quantity THEN
    RAISE EXCEPTION 'Supplier NF-e allocation exceeds the received quantity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_inbound_allocation_guard BEFORE INSERT ON fiscal_inbound_reconciliation_lines
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_inbound_allocation();

-- Projections change only the columns their owner can change afterwards.
CREATE FUNCTION guard_fiscal_purchase_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text := CASE TG_TABLE_NAME
    WHEN 'fiscal_purchase_receipts' THEN 'returned_at'
    WHEN 'fiscal_purchase_receipt_lines' THEN 'returned_quantity'
    ELSE 'reversed_at' END;
  before_value jsonb := to_jsonb(OLD) -> mutable;
  after_value jsonb := to_jsonb(NEW) -> mutable;
BEGIN
  IF to_jsonb(OLD) - mutable IS DISTINCT FROM to_jsonb(NEW) - mutable THEN
    RAISE EXCEPTION 'Fiscal purchase projection is immutable' USING ERRCODE = '23514';
  END IF;
  IF mutable = 'returned_quantity' THEN
    IF (after_value #>> '{}')::numeric < (before_value #>> '{}')::numeric THEN
      RAISE EXCEPTION 'Returned quantity never decreases' USING ERRCODE = '23514';
    END IF;
  ELSIF before_value <> 'null'::jsonb THEN
    RAISE EXCEPTION 'Fiscal purchase projection was already closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_purchase_receipts_guard BEFORE UPDATE ON fiscal_purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_purchase_projection();
CREATE TRIGGER fiscal_purchase_receipt_lines_guard BEFORE UPDATE ON fiscal_purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_purchase_projection();
CREATE TRIGGER fiscal_purchase_payables_guard BEFORE UPDATE ON fiscal_purchase_payables
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_purchase_projection();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fiscal_party_tax_index', 'fiscal_purchase_order_lines', 'fiscal_purchase_receipts',
    'fiscal_purchase_receipt_lines', 'fiscal_purchase_payables', 'fiscal_inbound_documents',
    'fiscal_inbound_conflicts', 'fiscal_inbound_conflict_dismissals',
    'fiscal_supplier_item_mappings', 'fiscal_inbound_reconciliations',
    'fiscal_inbound_reconciliation_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO horizon_app
         USING (tenant_id = current_setting(''app.current_tenant'')::uuid)
         WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)',
      table_name);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO horizon_app', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'fiscal_purchase_order_lines', 'fiscal_inbound_documents', 'fiscal_inbound_conflicts',
    'fiscal_inbound_conflict_dismissals', 'fiscal_supplier_item_mappings',
    'fiscal_inbound_reconciliations', 'fiscal_inbound_reconciliation_lines'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation()',
      table_name || '_immutable', table_name);
  END LOOP;
END $$;

GRANT UPDATE, DELETE ON fiscal_party_tax_index TO horizon_app;
GRANT UPDATE (returned_at) ON fiscal_purchase_receipts TO horizon_app;
GRANT UPDATE (returned_quantity) ON fiscal_purchase_receipt_lines TO horizon_app;
GRANT UPDATE (reversed_at) ON fiscal_purchase_payables TO horizon_app;
