CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units_of_measure" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL, "code" text NOT NULL,
  "name" text NOT NULL, "decimal_places" integer NOT NULL CHECK (decimal_places BETWEEN 0 AND 6),
  "active" integer DEFAULT 1 NOT NULL CHECK (active IN (0,1)), "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL, CONSTRAINT "units_tenant_code_key" UNIQUE("tenant_id","code"),
  CONSTRAINT "units_tenant_id_key" UNIQUE("tenant_id","id"),
  CONSTRAINT "units_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL, "kind" text NOT NULL CHECK (kind IN ('product','service')),
  "sku" text NOT NULL, "name" text NOT NULL, "unit_id" uuid NOT NULL, "ncm" text CHECK (ncm IS NULL OR ncm ~ '^\d{8}$'),
  "active" integer DEFAULT 1 NOT NULL CHECK (active IN (0,1)), "created_at" timestamptz NOT NULL, "updated_at" timestamptz NOT NULL,
  CONSTRAINT "catalog_items_tenant_sku_key" UNIQUE("tenant_id","sku"), CONSTRAINT "catalog_items_tenant_id_key" UNIQUE("tenant_id","id"),
  CONSTRAINT "catalog_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "catalog_items_tenant_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "units_of_measure"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL, "name" text NOT NULL, "currency" text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  "active" integer DEFAULT 1 NOT NULL CHECK (active IN (0,1)), "created_at" timestamptz NOT NULL, "updated_at" timestamptz NOT NULL,
  CONSTRAINT "price_lists_tenant_name_key" UNIQUE("tenant_id","name"), CONSTRAINT "price_lists_tenant_id_key" UNIQUE("tenant_id","id"),
  CONSTRAINT "price_lists_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
--> statement-breakpoint
CREATE TABLE "prices" (
  "tenant_id" uuid NOT NULL, "price_list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "amount" bigint NOT NULL CHECK (amount >= 0),
  "updated_at" timestamptz NOT NULL, PRIMARY KEY("tenant_id","price_list_id","item_id"),
  CONSTRAINT "prices_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "prices_tenant_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "price_lists"("tenant_id","id"),
  CONSTRAINT "prices_tenant_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "catalog_items"("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"), "event_id" uuid NOT NULL UNIQUE,
  "event_type" text NOT NULL, "event_version" smallint NOT NULL, "occurred_at" timestamptz NOT NULL, "trace_id" text NOT NULL,
  "trace_parent" text, "payload" jsonb NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "dispatched_at" timestamptz,
  "attempts" smallint DEFAULT 0 NOT NULL, "last_error" text
);
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL, "event_id" uuid NOT NULL, "event_type" text NOT NULL, "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL, CONSTRAINT "inbox_source_event_key" UNIQUE("source_module","event_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"), "sequence" bigint NOT NULL, "actor_id" uuid, "action" text NOT NULL,
  "subject_type" text NOT NULL, "subject_id" uuid NOT NULL, "request_id" text, "trace_id" text, "before" jsonb, "after" jsonb,
  "previous_hash" text NOT NULL, "hash" text NOT NULL, "occurred_at" timestamptz NOT NULL, PRIMARY KEY("tenant_id","sequence")
);
--> statement-breakpoint
CREATE INDEX "units_tenant_keyset_idx" ON "units_of_measure" ("tenant_id","created_at","id");
CREATE INDEX "catalog_items_tenant_keyset_idx" ON "catalog_items" ("tenant_id","created_at","id");
CREATE INDEX "price_lists_tenant_keyset_idx" ON "price_lists" ("tenant_id","created_at","id");
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['units_of_measure','catalog_items','price_lists','prices','outbox','inbox','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, units_of_measure, catalog_items, price_lists, prices, outbox, inbox, audit_log FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants, inbox, audit_log TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON units_of_measure, catalog_items, price_lists, prices TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_catalog_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_catalog_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION stamp_catalog_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  NEW.tenant_id := current_setting('app.current_tenant')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_catalog_outbox_tenant();
