CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 2 AND 160),
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "address" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('active', 'inactive', 'erased')),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "suppliers_tenant_id_key" UNIQUE ("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "description" text NOT NULL CHECK (char_length("description") BETWEEN 1 AND 160),
  "active" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "item_id")
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "requested_by" text NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "needed_by" date NOT NULL,
  "justification" text,
  "status" text NOT NULL CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled')),
  "submitted_by" text,
  "submitted_at" timestamp with time zone,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "order_id" uuid,
  "closure_reason" text,
  "version" integer NOT NULL CHECK ("version" >= 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "requisitions_tenant_id_key" UNIQUE ("tenant_id", "id"),
  -- A decision has a decider and a moment, or it has not been made.
  CONSTRAINT "requisitions_decision_check" CHECK (("decided_by" IS NULL) = ("decided_at" IS NULL)),
  CONSTRAINT "requisitions_rejection_check" CHECK ("status" <> 'rejected' OR "decision_reason" IS NOT NULL),
  CONSTRAINT "requisitions_ordered_check" CHECK (("status" = 'ordered') = ("order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "requisitions_status_idx" ON "requisitions" ("tenant_id", "status", "created_at" DESC, "id");
--> statement-breakpoint
CREATE TABLE "requisition_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "requisition_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  PRIMARY KEY ("tenant_id", "requisition_id", "line_id"),
  CONSTRAINT "requisition_lines_requisition_fk" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "requisitions" ("tenant_id", "id"),
  -- One line per item: a comparison against a quotation is made line by line.
  CONSTRAINT "requisition_lines_item_key" UNIQUE ("tenant_id", "requisition_id", "item_id")
);
--> statement-breakpoint
CREATE TABLE "quotations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "requisition_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "reference" text NOT NULL CHECK (char_length("reference") BETWEEN 1 AND 40),
  "quoted_on" date NOT NULL,
  "valid_until" date,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "tax" bigint NOT NULL CHECK ("tax" >= 0),
  "freight" bigint NOT NULL CHECK ("freight" >= 0),
  "other_charges" bigint NOT NULL CHECK ("other_charges" >= 0),
  "discount" bigint NOT NULL CHECK ("discount" >= 0),
  "total" bigint NOT NULL CHECK ("total" > 0),
  "payment_term_days" jsonb NOT NULL,
  "lead_time_days" integer NOT NULL CHECK ("lead_time_days" BETWEEN 0 AND 365),
  "notes" text,
  "status" text NOT NULL CHECK ("status" IN ('received', 'selected', 'declined')),
  "recorded_by" text NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "quotations_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "quotations_requisition_fk" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "requisitions" ("tenant_id", "id"),
  CONSTRAINT "quotations_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers" ("tenant_id", "id"),
  CONSTRAINT "quotations_validity_check" CHECK ("valid_until" IS NULL OR "valid_until" >= "quoted_on"),
  -- One supplier answers a requisition once; a changed offer is a new quotation.
  CONSTRAINT "quotations_supplier_key" UNIQUE ("tenant_id", "requisition_id", "supplier_id", "reference")
);
--> statement-breakpoint
CREATE INDEX "quotations_requisition_idx" ON "quotations" ("tenant_id", "requisition_id", "total");
--> statement-breakpoint
-- A requisition has at most one selected quotation: the buying decision is single.
CREATE UNIQUE INDEX "quotations_single_selection_key" ON "quotations" ("tenant_id", "requisition_id") WHERE "status" = 'selected';
--> statement-breakpoint
CREATE TABLE "quotation_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "quotation_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  PRIMARY KEY ("tenant_id", "quotation_id", "line_id"),
  CONSTRAINT "quotation_lines_quotation_fk" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotations" ("tenant_id", "id"),
  CONSTRAINT "quotation_lines_item_key" UNIQUE ("tenant_id", "quotation_id", "item_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "supplier_id" uuid NOT NULL,
  -- Copied, not joined: a supplier renamed next year must not rewrite this order.
  "supplier_name" text NOT NULL CHECK (char_length("supplier_name") BETWEEN 2 AND 160),
  "requisition_id" uuid,
  "quotation_id" uuid,
  "warehouse_id" uuid NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "tax" bigint NOT NULL CHECK ("tax" >= 0),
  "freight" bigint NOT NULL CHECK ("freight" >= 0),
  "other_charges" bigint NOT NULL CHECK ("other_charges" >= 0),
  "discount" bigint NOT NULL CHECK ("discount" >= 0),
  "total" bigint NOT NULL CHECK ("total" > 0),
  "payment_term_days" jsonb NOT NULL,
  "issued_on" date NOT NULL,
  "expected_on" date NOT NULL,
  "notes" text,
  "status" text NOT NULL CHECK ("status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  "approval_state" text NOT NULL CHECK ("approval_state" IN ('none', 'pending', 'approved', 'rejected', 'not-required')),
  "approval_requested_by" text,
  "approval_requested_at" timestamp with time zone,
  "approval_decided_by" text,
  "approval_decided_at" timestamp with time zone,
  "approval_reason" text,
  "closure_reason" text,
  "version" integer NOT NULL CHECK ("version" >= 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "orders_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "orders_requisition_fk" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "requisitions" ("tenant_id", "id"),
  CONSTRAINT "orders_quotation_fk" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotations" ("tenant_id", "id"),
  CONSTRAINT "orders_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers" ("tenant_id", "id"),
  CONSTRAINT "orders_delivery_check" CHECK ("expected_on" >= "issued_on"),
  CONSTRAINT "orders_decision_check" CHECK (("approval_decided_by" IS NULL) = ("approval_decided_at" IS NULL)),
  -- Four eyes: an approval nobody asked for is not an approval.
  CONSTRAINT "orders_four_eyes_check" CHECK (
    "approval_state" <> 'approved'
    OR "approval_requested_by" IS NULL
    OR "approval_decided_by" <> "approval_requested_by"
  ),
  CONSTRAINT "orders_cancellation_check" CHECK ("status" <> 'cancelled' OR "closure_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" ("tenant_id", "status", "issued_on" DESC, "id");
--> statement-breakpoint
CREATE INDEX "orders_supplier_idx" ON "orders" ("tenant_id", "supplier_id", "issued_on" DESC, "id");
--> statement-breakpoint
-- A requisition is answered by one order; a rejected or cancelled one frees it again.
CREATE UNIQUE INDEX "orders_single_answer_key" ON "orders" ("tenant_id", "requisition_id")
  WHERE "requisition_id" IS NOT NULL AND "status" IN ('draft', 'pending', 'approved');
--> statement-breakpoint
CREATE TABLE "order_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  PRIMARY KEY ("tenant_id", "order_id", "line_id"),
  CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders" ("tenant_id", "id"),
  CONSTRAINT "order_lines_item_key" UNIQUE ("tenant_id", "order_id", "item_id")
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "threshold" bigint NOT NULL CHECK ("threshold" >= 0),
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "currency")
);
--> statement-breakpoint
CREATE TABLE "command_receipts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 8 AND 255),
  "command" text NOT NULL,
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "actor" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "action" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "request_id" text,
  "trace_id" text,
  "details" jsonb NOT NULL,
  "previous_hash" text NOT NULL,
  "hash" text NOT NULL,
  CONSTRAINT "audit_log_tenant_sequence_key" UNIQUE ("tenant_id", "sequence")
);
--> statement-breakpoint
CREATE INDEX "audit_log_tenant_subject_idx" ON "audit_log" ("tenant_id", "subject_type", "subject_id", "sequence");
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_id" uuid NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "event_version" smallint NOT NULL CHECK (event_version > 0),
  "occurred_at" timestamptz NOT NULL,
  "trace_id" text NOT NULL,
  "trace_parent" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "dispatched_at" timestamptz,
  "attempts" smallint DEFAULT 0 NOT NULL CHECK (attempts >= 0),
  "last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_module", "event_id")
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO horizon_relay;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['suppliers','catalog_items','requisitions','requisition_lines','quotations','quotation_lines','orders','order_lines','approval_policies','command_receipts','audit_log','outbox','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, suppliers, catalog_items, requisitions, requisition_lines, quotations, quotation_lines, orders, order_lines, approval_policies, command_receipts, audit_log, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
-- Projections are replaced wholesale as the registry and the catalogue publish changes,
-- and destroyed when the subject is erased (ADR 0026).
GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON catalog_items TO horizon_app;
-- A requisition moves through its states; it is never deleted, because the decision to
-- refuse one is part of the record.
GRANT SELECT, INSERT ON requisitions TO horizon_app;
GRANT UPDATE ("needed_by", "justification", "status", "submitted_by", "submitted_at", "decided_by", "decided_at", "decision_reason", "order_id", "closure_reason", "version", "updated_at") ON requisitions TO horizon_app;
-- Lines are rewritten only while the requisition is a draft, which the domain enforces.
GRANT SELECT, INSERT, DELETE ON requisition_lines TO horizon_app;
-- A quotation is a record of what a supplier said; only its status ever changes.
GRANT SELECT, INSERT ON quotations TO horizon_app;
GRANT UPDATE ("status", "decided_at", "updated_at") ON quotations TO horizon_app;
GRANT SELECT, INSERT ON quotation_lines TO horizon_app;
-- An order's terms change only while it is a draft; from approval on, only its state does.
GRANT SELECT, INSERT ON orders TO horizon_app;
GRANT UPDATE ("tax", "freight", "other_charges", "discount", "total", "payment_term_days", "expected_on", "notes", "status", "approval_state", "approval_requested_by", "approval_requested_at", "approval_decided_by", "approval_decided_at", "approval_reason", "closure_reason", "version", "updated_at") ON orders TO horizon_app;
GRANT SELECT, INSERT, DELETE ON order_lines TO horizon_app;
GRANT SELECT, INSERT ON approval_policies TO horizon_app;
GRANT UPDATE ("threshold", "updated_by", "updated_at") ON approval_policies TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, INSERT ON inbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
-- A committed order is not edited. Its lines may be written while it is a draft and are
-- fixed from the moment somebody is asked to approve it, whatever the application believes.
CREATE FUNCTION reject_committed_order_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
BEGIN
  SELECT status INTO order_status FROM orders
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.order_id, OLD.order_id);
  IF order_status IS NOT NULL AND order_status <> 'draft' THEN
    RAISE EXCEPTION 'order lines cannot change once the order has been placed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER order_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION reject_committed_order_lines();
--> statement-breakpoint
-- The same for a requisition: once it has been submitted, what was asked for is fixed.
CREATE FUNCTION reject_submitted_requisition_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requisition_status text;
BEGIN
  SELECT status INTO requisition_status FROM requisitions
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.requisition_id, OLD.requisition_id);
  IF requisition_status IS NOT NULL AND requisition_status <> 'draft' THEN
    RAISE EXCEPTION 'requisition lines cannot change once it has been submitted';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER requisition_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON requisition_lines
  FOR EACH ROW EXECUTE FUNCTION reject_submitted_requisition_lines();
--> statement-breakpoint
-- A quotation is only ever recorded against a requisition still open to being answered.
CREATE FUNCTION require_open_requisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requisition_status text;
BEGIN
  SELECT status INTO requisition_status FROM requisitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.requisition_id;
  IF requisition_status NOT IN ('submitted', 'approved') THEN
    RAISE EXCEPTION 'a % requisition is not open to quotations', requisition_status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotations_open_requisition BEFORE INSERT ON quotations
  FOR EACH ROW EXECUTE FUNCTION require_open_requisition();
--> statement-breakpoint
CREATE FUNCTION stamp_procurement_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_procurement_outbox_tenant();
