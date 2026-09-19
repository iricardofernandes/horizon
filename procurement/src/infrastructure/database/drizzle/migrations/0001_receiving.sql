-- What has arrived against each line, cumulative across every delivery, and how many
-- deliveries there have been.
ALTER TABLE "order_lines" ADD COLUMN "received" bigint NOT NULL DEFAULT 0 CHECK ("received" >= 0);
ALTER TABLE "orders" ADD COLUMN "receipts" integer NOT NULL DEFAULT 0 CHECK ("receipts" >= 0);
--> statement-breakpoint
-- An order that is receiving, has received everything, or will receive nothing more.
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (
  "status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'received', 'closed')
);
--> statement-breakpoint
-- An order that reached goods is still the answer to its requisition.
DROP INDEX "orders_single_answer_key";
CREATE UNIQUE INDEX "orders_single_answer_key" ON "orders" ("tenant_id", "requisition_id")
  WHERE "requisition_id" IS NOT NULL
    AND "status" IN ('draft', 'pending', 'approved', 'received', 'closed');
--> statement-breakpoint
CREATE TABLE "receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "received_on" date NOT NULL,
  "received_by" text NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- The share of the order's total these goods carry, and therefore what they made owed.
  "value" bigint NOT NULL CHECK ("value" >= 0),
  "notes" text,
  -- Present exactly when more arrived than was ordered: a delivery nobody agreed to is a
  -- cost nobody agreed to, so accepting one is always deliberate and always explained.
  "override_reason" text,
  "status" text NOT NULL CHECK ("status" IN ('recorded', 'returned')),
  "returned_by" text,
  "returned_at" timestamp with time zone,
  "return_reason" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "receipts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "receipts_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders" ("tenant_id", "id"),
  CONSTRAINT "receipts_return_check" CHECK (
    ("status" = 'returned') = ("returned_by" IS NOT NULL AND "returned_at" IS NOT NULL AND "return_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "receipts_order_idx" ON "receipts" ("tenant_id", "order_id", "received_on", "id");
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "receipt_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  PRIMARY KEY ("tenant_id", "receipt_id", "line_id"),
  CONSTRAINT "receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "receipts" ("tenant_id", "id")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['receipts','receipt_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON receipts, receipt_lines FROM horizon_app, horizon_relay;
-- A delivery is a record of something that happened; only its return ever changes it.
GRANT SELECT, INSERT ON receipts TO horizon_app;
GRANT UPDATE ("status", "returned_by", "returned_at", "return_reason") ON receipts TO horizon_app;
GRANT SELECT, INSERT ON receipt_lines TO horizon_app;
-- What has arrived is the one thing about a committed order's lines that does change.
GRANT UPDATE ("received") ON order_lines TO horizon_app;
GRANT UPDATE ("receipts") ON orders TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_receipt_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'a delivery is returned, never rewritten'; END $$;
CREATE TRIGGER receipt_lines_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_receipt_line_mutation();
--> statement-breakpoint
-- The lines of a committed order are still fixed; what has arrived against them is not.
CREATE OR REPLACE FUNCTION reject_committed_order_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
BEGIN
  -- An update that touches nothing but `received` is the delivery being recorded.
  IF TG_OP = 'UPDATE'
     AND (NEW.line_id, NEW.item_id, NEW.description, NEW.quantity, NEW.unit_price, NEW.line_total)
         IS NOT DISTINCT FROM
         (OLD.line_id, OLD.item_id, OLD.description, OLD.quantity, OLD.unit_price, OLD.line_total)
  THEN
    RETURN NEW;
  END IF;
  SELECT status INTO order_status FROM orders
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.order_id, OLD.order_id);
  IF order_status IS NOT NULL AND order_status <> 'draft' THEN
    RAISE EXCEPTION 'order lines cannot change once the order has been placed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
-- Nothing arrives against an order nobody approved, whatever the application believes.
CREATE FUNCTION require_receiving_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
BEGIN
  SELECT status INTO order_status FROM orders
    WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_status NOT IN ('approved', 'received') THEN
    RAISE EXCEPTION 'a % order is not receiving goods', order_status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipts_receiving_order BEFORE INSERT ON receipts
  FOR EACH ROW EXECUTE FUNCTION require_receiving_order();
