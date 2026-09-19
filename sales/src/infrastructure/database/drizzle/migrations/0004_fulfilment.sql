-- What has left for the customer, and what is being picked to leave next.
ALTER TABLE "sales_order_lines" ADD COLUMN "shipped" bigint NOT NULL DEFAULT 0
  CHECK ("shipped" >= 0);
ALTER TABLE "sales_order_lines" ALTER COLUMN "shipped" DROP DEFAULT;
ALTER TABLE "sales_order_lines" ADD COLUMN "allocated" bigint NOT NULL DEFAULT 0
  CHECK ("allocated" >= 0);
ALTER TABLE "sales_order_lines" ALTER COLUMN "allocated" DROP DEFAULT;
-- Nothing may be promised twice: what has gone plus what is being picked never exceeds
-- what was ordered.
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_committed_check" CHECK (
  "shipped" + "allocated" <= "quantity"
);
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "fulfillment" text NOT NULL DEFAULT 'unfulfilled'
  CHECK ("fulfillment" IN ('unfulfilled', 'partial', 'fulfilled'));
ALTER TABLE "sales_orders" ALTER COLUMN "fulfillment" DROP DEFAULT;
ALTER TABLE "sales_orders" ADD COLUMN "shipments" integer NOT NULL DEFAULT 0
  CHECK ("shipments" >= 0);
ALTER TABLE "sales_orders" ALTER COLUMN "shipments" DROP DEFAULT;
ALTER TABLE "sales_orders" ADD COLUMN "confirmed_at" timestamptz;
-- An order confirmed before deliveries existed shipped when it was confirmed: that is what
-- the stock movement of the day recorded, and the books were written from it.
ALTER TABLE "sales_orders" NO FORCE ROW LEVEL SECURITY;
UPDATE "sales_orders" SET "fulfillment" = 'fulfilled', "confirmed_at" = "updated_at"
  WHERE "status" = 'confirmed';
ALTER TABLE "sales_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales_order_lines" NO FORCE ROW LEVEL SECURITY;
UPDATE "sales_order_lines" SET "shipped" = "quantity"
  WHERE "order_id" IN (SELECT "id" FROM "sales_orders" WHERE "status" = 'confirmed');
ALTER TABLE "sales_order_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- One delivery against an order: what is in the box, what it is worth, and where it got to.
CREATE TABLE "shipments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "status" text NOT NULL CHECK (
    "status" IN ('picking', 'packed', 'dispatched', 'returned', 'abandoned')
  ),
  "value" bigint NOT NULL CHECK ("value" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "carrier" text,
  "tracking_code" text,
  "picked_by" text NOT NULL,
  "packed_by" text,
  "dispatched_by" text,
  "dispatched_on" date,
  "returned_by" text,
  "returned_on" date,
  "closure_reason" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "shipments_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "shipments_order_fk" FOREIGN KEY ("tenant_id", "order_id")
    REFERENCES "sales_orders" ("tenant_id", "id"),
  -- A delivery that left says when and by whom; one that came back says why.
  CONSTRAINT "shipments_dispatch_check" CHECK (
    ("status" IN ('dispatched', 'returned'))
      = ("dispatched_on" IS NOT NULL AND "dispatched_by" IS NOT NULL)
  ),
  CONSTRAINT "shipments_return_check" CHECK (
    "status" <> 'returned' OR ("returned_on" IS NOT NULL AND "closure_reason" IS NOT NULL)
  ),
  CONSTRAINT "shipments_abandoned_check" CHECK (
    "status" <> 'abandoned' OR "closure_reason" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE TABLE "shipment_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "shipment_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "description" text NOT NULL,
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  PRIMARY KEY ("tenant_id", "shipment_id", "line_id"),
  CONSTRAINT "shipment_lines_shipment_fk" FOREIGN KEY ("tenant_id", "shipment_id")
    REFERENCES "shipments" ("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" ("tenant_id", "order_id", "created_at");
CREATE INDEX "shipments_status_idx" ON "shipments" ("tenant_id", "status", "created_at");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['shipments','shipment_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON shipments, shipment_lines FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON shipments TO horizon_app;
GRANT SELECT, INSERT, DELETE ON shipment_lines TO horizon_app;
--> statement-breakpoint
-- A delivery that has left is the record of a physical event, and is never rewritten.
CREATE FUNCTION reject_dispatched_shipment_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shipment_status text;
BEGIN
  SELECT status INTO shipment_status FROM shipments
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.shipment_id, OLD.shipment_id);
  IF shipment_status IS NOT NULL AND shipment_status NOT IN ('picking', 'packed') THEN
    RAISE EXCEPTION 'shipment lines cannot change once the goods have left';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER shipment_lines_before_dispatch BEFORE INSERT OR UPDATE OR DELETE ON shipment_lines
  FOR EACH ROW EXECUTE FUNCTION reject_dispatched_shipment_lines();
