CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "unit_price" bigint CHECK (unit_price IS NULL OR unit_price >= 0),
  "currency" text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  "active" integer DEFAULT 1 NOT NULL CHECK (active IN (0, 1)),
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "item_id"),
  CONSTRAINT "catalog_items_price_currency_check" CHECK ((unit_price IS NULL) = (currency IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "customer_id" uuid NOT NULL,
  "fulfillment_warehouse_id" uuid NOT NULL,
  "status" text NOT NULL CHECK (status IN ('draft', 'placed', 'confirmed', 'rejected', 'cancelled')),
  "version" integer NOT NULL CHECK (version >= 0),
  "reservation_id" uuid,
  "total" bigint CHECK (total IS NULL OR total >= 0),
  "currency" text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "sales_orders_total_currency_check" CHECK ((total IS NULL) = (currency IS NULL)),
  CONSTRAINT "sales_orders_tenant_id_key" UNIQUE("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK (quantity > 0),
  "description" text,
  "unit_price" bigint CHECK (unit_price IS NULL OR unit_price >= 0),
  "line_total" bigint CHECK (line_total IS NULL OR line_total >= 0),
  "currency" text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY ("tenant_id", "order_id", "line_id"),
  CONSTRAINT "sales_order_lines_tenant_order_item_key" UNIQUE("tenant_id", "order_id", "item_id"),
  CONSTRAINT "sales_order_lines_commercial_check" CHECK (
    (description IS NULL AND unit_price IS NULL AND line_total IS NULL AND currency IS NULL)
    OR
    (description IS NOT NULL AND unit_price IS NOT NULL AND line_total IS NOT NULL AND currency IS NOT NULL)
  ),
  CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "sales_orders"("tenant_id", "id")
);
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
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_source_event_key" UNIQUE("source_module", "event_id")
);
--> statement-breakpoint
CREATE INDEX "sales_orders_tenant_customer_idx" ON "sales_orders" ("tenant_id", "customer_id", "created_at");
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalog_items','sales_orders','sales_order_lines','outbox','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, catalog_items, sales_orders, sales_order_lines, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants, inbox TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON catalog_items, sales_orders, sales_order_lines TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION stamp_sales_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  NEW.tenant_id := current_setting('app.current_tenant')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_sales_outbox_tenant();
