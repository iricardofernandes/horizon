-- Stock can now move because somebody decided it should, rather than only because an
-- order did. Inventory predates the audit log and the command receipts every later
-- module keeps; both arrive here, because those decisions are exactly the ones that need
-- a name against them.
CREATE TABLE "command_receipts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 8 AND 255),
  "command" text NOT NULL,
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
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
  "occurred_at" timestamptz NOT NULL,
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
-- A movement made by a person says why, and under which document. A sale and a purchase
-- leave both null: the order already explains them.
ALTER TABLE "stock_movements" ADD COLUMN "reason" text;
ALTER TABLE "stock_movements" ADD COLUMN "document_type" text;
ALTER TABLE "stock_movements" ADD COLUMN "document_id" uuid;
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  "kind" IN ('receipt', 'shipment', 'adjustment-in', 'adjustment-out', 'return-in', 'transfer-in', 'transfer-out')
);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN ('transfer', 'count', 'breakage', 'loss', 'theft', 'expiry', 'found', 'correction')
);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_check" CHECK (
  ("document_type" IS NULL) = ("document_id" IS NULL)
  AND ("document_type" IS NULL OR "document_type" IN ('transfer', 'adjustment', 'count'))
);
--> statement-breakpoint
-- Goods move between two of the company's own warehouses. There is no state to pass
-- through: by the time one is recorded it has already happened.
CREATE TABLE "stock_transfers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "source_warehouse_id" uuid NOT NULL,
  "destination_warehouse_id" uuid NOT NULL,
  "note" text,
  "moved_by" text NOT NULL,
  "moved_at" timestamptz NOT NULL,
  CONSTRAINT "stock_transfers_two_warehouses_check" CHECK ("source_warehouse_id" <> "destination_warehouse_id"),
  CONSTRAINT "stock_transfers_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "stock_transfers_source_fk" FOREIGN KEY ("tenant_id", "source_warehouse_id") REFERENCES "warehouses"("tenant_id", "id"),
  CONSTRAINT "stock_transfers_destination_fk" FOREIGN KEY ("tenant_id", "destination_warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "transfer_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  PRIMARY KEY ("tenant_id", "transfer_id", "item_id"),
  CONSTRAINT "stock_transfer_lines_transfer_fk" FOREIGN KEY ("tenant_id", "transfer_id") REFERENCES "stock_transfers"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_moved_idx" ON "stock_transfers" ("tenant_id", "moved_at");
--> statement-breakpoint
-- Somebody changes how much stock there is with nobody having bought or sold anything.
CREATE TABLE "stock_adjustments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "direction" text NOT NULL CHECK ("direction" IN ('in', 'out')),
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "reason" text NOT NULL CHECK ("reason" IN ('breakage', 'loss', 'theft', 'expiry', 'found', 'correction')),
  "note" text,
  "stated_unit_cost" bigint CHECK ("stated_unit_cost" IS NULL OR "stated_unit_cost" >= 0),
  "stated_currency" text CHECK ("stated_currency" IS NULL OR "stated_currency" ~ '^[A-Z]{3}$'),
  "value" bigint CHECK ("value" IS NULL OR "value" >= 0),
  "value_currency" text CHECK ("value_currency" IS NULL OR "value_currency" ~ '^[A-Z]{3}$'),
  "status" text NOT NULL CHECK ("status" IN ('pending', 'posted', 'rejected')),
  "approval_state" text NOT NULL CHECK ("approval_state" IN ('not-required', 'pending', 'approved', 'rejected')),
  "requested_by" text NOT NULL,
  "requested_at" timestamptz NOT NULL,
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_reason" text,
  "posted_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "stock_adjustments_stated_cost_check" CHECK (("stated_unit_cost" IS NULL) = ("stated_currency" IS NULL)),
  CONSTRAINT "stock_adjustments_valuation_check" CHECK (("value" IS NULL) = ("value_currency" IS NULL)),
  -- Four eyes: allowing your own write-off is not an approval.
  CONSTRAINT "stock_adjustments_four_eyes_check" CHECK (
    "approval_state" NOT IN ('approved', 'rejected') OR "decided_by" <> "requested_by"
  ),
  CONSTRAINT "stock_adjustments_decision_check" CHECK (
    "approval_state" IN ('not-required', 'pending') OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  ),
  CONSTRAINT "stock_adjustments_posted_check" CHECK (("status" = 'posted') = ("posted_at" IS NOT NULL)),
  CONSTRAINT "stock_adjustments_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "stock_adjustments_warehouse_fk" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "stock_adjustments_tenant_status_idx" ON "stock_adjustments" ("tenant_id", "status", "requested_at");
--> statement-breakpoint
-- Somebody walks the aisles. The sheet freezes what the system expected when it opened,
-- and closing it posts the difference against whatever the balance has become since.
CREATE TABLE "stock_counts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "warehouse_id" uuid NOT NULL,
  "note" text,
  "status" text NOT NULL CHECK ("status" IN ('open', 'pending', 'closed', 'cancelled')),
  "approval_state" text NOT NULL CHECK ("approval_state" IN ('not-required', 'pending', 'approved', 'rejected')),
  "opened_by" text NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "closed_by" text,
  "closed_at" timestamptz,
  "decided_by" text,
  "decided_at" timestamptz,
  "closure_reason" text,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "stock_counts_four_eyes_check" CHECK (
    "approval_state" NOT IN ('approved', 'rejected') OR "closed_by" IS NULL OR "decided_by" <> "closed_by"
  ),
  CONSTRAINT "stock_counts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "stock_counts_warehouse_fk" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "count_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "expected" bigint NOT NULL CHECK ("expected" >= 0),
  -- Null is "nobody counted this", which is not the same as having counted zero.
  "counted" bigint CHECK ("counted" IS NULL OR "counted" >= 0),
  PRIMARY KEY ("tenant_id", "count_id", "item_id"),
  CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("tenant_id", "count_id") REFERENCES "stock_counts"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "stock_counts_tenant_status_idx" ON "stock_counts" ("tenant_id", "status", "opened_at");
--> statement-breakpoint
-- The value at or above which an adjustment waits for a second person. A workspace with
-- no row here has every adjustment approved: silence about a control is not permission
-- to skip it, which is also why the row cannot be deleted.
CREATE TABLE "adjustment_policies" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "threshold" bigint NOT NULL CHECK ("threshold" >= 0),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "currency")
);
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['stock_transfers','stock_transfer_lines','stock_adjustments','stock_counts','stock_count_lines','adjustment_policies','command_receipts','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON stock_transfers, stock_transfer_lines, stock_adjustments, stock_counts, stock_count_lines, adjustment_policies, command_receipts, audit_log FROM horizon_app, horizon_relay;
-- A transfer is written once and never touched again; correcting one is another transfer.
GRANT SELECT, INSERT ON stock_transfers, stock_transfer_lines TO horizon_app;
-- An adjustment is asked for and then decided; what it asks for never changes.
GRANT SELECT, INSERT ON stock_adjustments TO horizon_app;
GRANT UPDATE ("status", "approval_state", "decided_by", "decided_at", "decision_reason", "posted_at", "updated_at") ON stock_adjustments TO horizon_app;
GRANT SELECT, INSERT ON stock_counts TO horizon_app;
GRANT UPDATE ("status", "approval_state", "closed_by", "closed_at", "decided_by", "decided_at", "closure_reason", "updated_at") ON stock_counts TO horizon_app;
-- What the sheet expected was frozen when it opened; only the count itself is written.
GRANT SELECT, INSERT ON stock_count_lines TO horizon_app;
GRANT UPDATE ("counted") ON stock_count_lines TO horizon_app;
GRANT SELECT, INSERT ON adjustment_policies TO horizon_app;
GRANT UPDATE ("threshold", "updated_by", "updated_at") ON adjustment_policies TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_inventory_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_audit_mutation();
--> statement-breakpoint
-- A transfer that has been made is not rewritten, whatever gets past the aggregate.
CREATE FUNCTION reject_inventory_transfer_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'a transfer that has been made cannot be changed'; END $$;
CREATE TRIGGER stock_transfer_lines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_transfer_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_transfer_line_mutation();
--> statement-breakpoint
-- A count that has been settled takes no more figures. Without this, a row written after
-- the differences were posted would describe a sheet that never produced them.
CREATE FUNCTION reject_settled_inventory_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settled text;
BEGIN
  SELECT "status" INTO settled FROM "stock_counts" WHERE "id" = NEW."count_id";
  IF settled <> 'open' THEN RAISE EXCEPTION 'this count is no longer open'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_count_lines_open_only BEFORE UPDATE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION reject_settled_inventory_count();
