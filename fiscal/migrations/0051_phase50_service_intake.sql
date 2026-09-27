-- Phase 50: services delivered in Sales become NFS-e here (ADR 0056). Each delivered line
-- is received once, keyed by its entry id, and worked into a service origin and a draft.
-- Nothing here creates a stock or money effect.

-- How an establishment issues those NFS-e: `review` leaves the draft for a person,
-- `automatic` validates and issues it. No row means `review` on series 1.
CREATE TABLE fiscal_service_issuance_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  establishment_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('review', 'automatic')),
  series integer NOT NULL CHECK (series BETWEEN 1 AND 999),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, establishment_id)
);

-- One delivered service line and where it is on its way to an NFS-e. The facts are the
-- Sales event's and never change; the progress columns only move forward.
CREATE TABLE fiscal_service_intakes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_module text NOT NULL CHECK (source_module = 'sales'),
  source_document_type text NOT NULL CHECK (source_document_type = 'service-delivery'),
  entry_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  delivery_id uuid NOT NULL,
  service_order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  service_item_id uuid NOT NULL,
  competence_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  facts_digest text NOT NULL CHECK (facts_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN (
    'pending', 'blocked', 'drafted', 'issuing', 'cancelling', 'withdrawn',
    'cancellation-refused'
  )),
  reason text CHECK (length(reason) BETWEEN 1 AND 1000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  withdrawal_requested boolean NOT NULL DEFAULT false,
  withdrawal_reason text CHECK (length(withdrawal_reason) BETWEEN 1 AND 500),
  establishment_id uuid,
  service_origin_id uuid,
  document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_service_intake_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT fiscal_service_intake_entry_key UNIQUE (tenant_id, entry_id),
  CONSTRAINT fiscal_service_intake_blocked_check CHECK (
    status NOT IN ('blocked', 'cancellation-refused') OR reason IS NOT NULL
  ),
  CONSTRAINT fiscal_service_intake_withdrawal_check CHECK (
    withdrawal_requested = (withdrawal_reason IS NOT NULL)
  )
);
CREATE INDEX fiscal_service_intakes_work
  ON fiscal_service_intakes (tenant_id, status, next_attempt_at);
CREATE INDEX fiscal_service_intakes_delivery
  ON fiscal_service_intakes (tenant_id, delivery_id);
CREATE INDEX fiscal_service_intakes_document
  ON fiscal_service_intakes (tenant_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX fiscal_service_intakes_recent
  ON fiscal_service_intakes (tenant_id, created_at DESC, id DESC);

CREATE FUNCTION guard_fiscal_service_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR (OLD.id, OLD.tenant_id, OLD.source_module, OLD.source_document_type, OLD.entry_id,
        OLD.period, OLD.delivery_id, OLD.service_order_id, OLD.customer_id,
        OLD.service_item_id, OLD.competence_date, OLD.amount_minor, OLD.currency,
        OLD.description, OLD.facts_digest, OLD.created_at)
      IS DISTINCT FROM
       (NEW.id, NEW.tenant_id, NEW.source_module, NEW.source_document_type, NEW.entry_id,
        NEW.period, NEW.delivery_id, NEW.service_order_id, NEW.customer_id,
        NEW.service_item_id, NEW.competence_date, NEW.amount_minor, NEW.currency,
        NEW.description, NEW.facts_digest, NEW.created_at)
    OR (OLD.establishment_id IS NOT NULL
        AND NEW.establishment_id IS DISTINCT FROM OLD.establishment_id)
    OR (OLD.service_origin_id IS NOT NULL
        AND NEW.service_origin_id IS DISTINCT FROM OLD.service_origin_id)
    OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
    OR (OLD.withdrawal_requested AND NOT NEW.withdrawal_requested)
    OR OLD.status = 'withdrawn'
  THEN
    RAISE EXCEPTION 'A fiscal service intake only moves forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_service_intakes_forward
  BEFORE UPDATE OR DELETE ON fiscal_service_intakes
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_service_intake();

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['fiscal_service_issuance_policies', 'fiscal_service_intakes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app
      USING (tenant_id = current_setting(''app.current_tenant'')::uuid)
      WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO horizon_app', name);
  END LOOP;
END $$;
