-- Phase 50: services sold to a customer and delivered stage by stage (ADR 0056). A service
-- order has no warehouse and reserves nothing; its deliveries are what gets billed.
CREATE TABLE "service_orders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "customer_id" uuid NOT NULL,
  "quote_id" uuid,
  "status" text NOT NULL CHECK (
    "status" IN ('scheduled', 'in_progress', 'completed', 'accepted', 'cancelled')
  ),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "net" bigint NOT NULL CHECK ("net" >= 0),
  "discount" bigint NOT NULL CHECK ("discount" >= 0 AND "discount" <= "net"),
  "total" bigint NOT NULL CHECK ("total" = "net" - "discount"),
  "billed" bigint NOT NULL CHECK ("billed" >= 0 AND "billed" <= "total"),
  "payment_term_days" jsonb NOT NULL,
  "notes" text,
  "scheduled_for" date,
  "opened_on" date NOT NULL,
  "created_by" text NOT NULL,
  "accepted_by" text,
  "closure_reason" text,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "service_orders_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "service_orders_customer_fk" FOREIGN KEY ("tenant_id", "customer_id")
    REFERENCES "customers" ("tenant_id", "id"),
  CONSTRAINT "service_orders_quote_fk" FOREIGN KEY ("tenant_id", "quote_id")
    REFERENCES "quotes" ("tenant_id", "id"),
  CONSTRAINT "service_orders_cancelled_check" CHECK (
    "status" <> 'cancelled' OR "closure_reason" IS NOT NULL
  ),
  CONSTRAINT "service_orders_accepted_check" CHECK (
    ("status" = 'accepted') = ("accepted_by" IS NOT NULL)
  )
);
--> statement-breakpoint
-- One proposal converts once, so it has at most one service order.
CREATE UNIQUE INDEX "service_orders_one_per_quote" ON "service_orders" ("tenant_id", "quote_id")
  WHERE "quote_id" IS NOT NULL;
CREATE INDEX "service_orders_status_idx" ON "service_orders" ("tenant_id", "status", "created_at");
CREATE INDEX "service_orders_customer_idx" ON "service_orders" ("tenant_id", "customer_id", "created_at");
--> statement-breakpoint
CREATE TABLE "service_order_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "service_order_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  "delivered" bigint NOT NULL CHECK ("delivered" >= 0),
  "position" smallint NOT NULL CHECK ("position" >= 0),
  PRIMARY KEY ("tenant_id", "service_order_id", "line_id"),
  CONSTRAINT "service_order_lines_order_fk" FOREIGN KEY ("tenant_id", "service_order_id")
    REFERENCES "service_orders" ("tenant_id", "id"),
  -- Nothing is delivered twice: what was delivered never exceeds what was sold.
  CONSTRAINT "service_order_lines_within_quantity_check" CHECK ("delivered" <= "quantity")
);
--> statement-breakpoint
CREATE TABLE "service_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "service_order_id" uuid NOT NULL,
  "performed_on" date NOT NULL,
  "value" bigint NOT NULL CHECK ("value" > 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "delivered_by" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('active', 'cancelled')),
  "cancelled_by" text,
  "cancelled_on" date,
  "cancellation_reason" text,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "service_deliveries_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "service_deliveries_order_fk" FOREIGN KEY ("tenant_id", "service_order_id")
    REFERENCES "service_orders" ("tenant_id", "id"),
  CONSTRAINT "service_deliveries_cancellation_check" CHECK (
    ("status" = 'cancelled') = (
      "cancelled_by" IS NOT NULL AND "cancelled_on" IS NOT NULL
        AND "cancellation_reason" IS NOT NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX "service_deliveries_order_idx"
  ON "service_deliveries" ("tenant_id", "service_order_id", "created_at");
--> statement-breakpoint
CREATE TABLE "service_delivery_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "delivery_id" uuid NOT NULL,
  "entry_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "line_total" bigint NOT NULL CHECK ("line_total" >= 0),
  "amount" bigint NOT NULL CHECK ("amount" >= 0),
  "position" smallint NOT NULL CHECK ("position" >= 0),
  PRIMARY KEY ("tenant_id", "entry_id"),
  CONSTRAINT "service_delivery_lines_line_key" UNIQUE ("tenant_id", "delivery_id", "line_id"),
  CONSTRAINT "service_delivery_lines_delivery_fk" FOREIGN KEY ("tenant_id", "delivery_id")
    REFERENCES "service_deliveries" ("tenant_id", "id")
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "service_order_id" uuid;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'service_orders', 'service_order_lines', 'service_deliveries', 'service_delivery_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON service_orders, service_order_lines, service_deliveries, service_delivery_lines
  FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON service_orders, service_order_lines, service_deliveries
  TO horizon_app;
GRANT SELECT, INSERT ON service_delivery_lines TO horizon_app;
--> statement-breakpoint
-- A recorded delivery is the fact that was billed. Only its cancellation may be written
-- afterwards, once; the work, the day and the value never change.
CREATE FUNCTION reject_service_delivery_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.service_order_id, NEW.performed_on, NEW.value, NEW.currency,
      NEW.delivered_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.service_order_id, OLD.performed_on, OLD.value, OLD.currency,
      OLD.delivered_by, OLD.created_at)
     OR OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'a recorded service delivery is never rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_deliveries_immutable BEFORE UPDATE ON service_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_service_delivery_rewrite();
