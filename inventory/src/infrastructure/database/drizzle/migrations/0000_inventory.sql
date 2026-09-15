CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL,
  "active" integer DEFAULT 1 NOT NULL CHECK (active IN (0, 1)),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "warehouses_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "warehouses_tenant_name_key" UNIQUE("tenant_id", "name")
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "on_hand" bigint DEFAULT 0 NOT NULL CHECK (on_hand >= 0),
  "reserved" bigint DEFAULT 0 NOT NULL CHECK (reserved >= 0 AND reserved <= on_hand),
  "average_unit_cost" bigint CHECK (average_unit_cost IS NULL OR average_unit_cost >= 0),
  "currency" text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  "version" integer DEFAULT 0 NOT NULL CHECK (version >= 0),
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "stock_balances_cost_currency_check" CHECK ((average_unit_cost IS NULL) = (currency IS NULL)),
  CONSTRAINT "stock_balances_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "stock_balances_tenant_item_warehouse_key" UNIQUE("tenant_id", "item_id", "warehouse_id"),
  CONSTRAINT "stock_balances_tenant_warehouse_fk" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "order_version" integer NOT NULL CHECK (order_version > 0),
  "status" text NOT NULL CHECK (status IN ('active', 'confirmed', 'released')),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "stock_reservations_expiry_check" CHECK (expires_at > created_at),
  CONSTRAINT "stock_reservations_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "stock_reservations_tenant_order_key" UNIQUE("tenant_id", "order_id")
);
--> statement-breakpoint
CREATE TABLE "stock_reservation_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "reservation_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY ("tenant_id", "reservation_id", "line_id"),
  CONSTRAINT "stock_reservation_lines_reservation_fk" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "stock_reservations"("tenant_id", "id"),
  CONSTRAINT "stock_reservation_lines_balance_fk" FOREIGN KEY ("tenant_id", "item_id", "warehouse_id") REFERENCES "stock_balances"("tenant_id", "item_id", "warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "balance_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK (kind IN ('receipt', 'shipment', 'adjustment-in', 'adjustment-out')),
  "quantity" bigint NOT NULL CHECK (quantity > 0),
  "balance_after" bigint NOT NULL CHECK (balance_after >= 0),
  "unit_cost" bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
  "currency" text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  "balance_version" integer NOT NULL CHECK (balance_version > 0),
  "occurred_at" timestamptz NOT NULL,
  CONSTRAINT "stock_movements_cost_currency_check" CHECK ((unit_cost IS NULL) = (currency IS NULL)),
  CONSTRAINT "stock_movements_balance_version_key" UNIQUE("tenant_id", "balance_id", "balance_version"),
  CONSTRAINT "stock_movements_balance_fk" FOREIGN KEY ("tenant_id", "balance_id") REFERENCES "stock_balances"("tenant_id", "id")
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
CREATE INDEX "stock_reservations_expiry_idx" ON "stock_reservations" ("tenant_id", "status", "expires_at");
CREATE INDEX "stock_movements_tenant_item_idx" ON "stock_movements" ("tenant_id", "item_id", "occurred_at");
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['warehouses','stock_balances','stock_reservations','stock_reservation_lines','stock_movements','outbox','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, warehouses, stock_balances, stock_reservations, stock_reservation_lines, stock_movements, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants, stock_movements, inbox TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON warehouses, stock_balances, stock_reservations TO horizon_app;
GRANT SELECT, INSERT ON stock_reservation_lines TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_inventory_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock_movements is append-only'; END $$;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_movement_mutation();
--> statement-breakpoint
CREATE FUNCTION stamp_inventory_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  NEW.tenant_id := current_setting('app.current_tenant')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_inventory_outbox_tenant();
