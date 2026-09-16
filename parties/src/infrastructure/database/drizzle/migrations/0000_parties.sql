CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_data_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "material" text,
  "erased_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "party_data_keys_tenant_id_key" UNIQUE("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "parties" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('organization', 'person')),
  "legal_name_ciphertext" text NOT NULL,
  "trade_name_ciphertext" text,
  "tax_id_ciphertext" text NOT NULL,
  "tax_id_index" text NOT NULL,
  "email_ciphertext" text NOT NULL,
  "phone_ciphertext" text NOT NULL,
  "address_ciphertext" text NOT NULL,
  "roles" text[] NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('active', 'inactive', 'erased')),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "parties_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "parties_tenant_tax_id_index_key" UNIQUE("tenant_id", "tax_id_index"),
  CONSTRAINT "parties_tenant_data_key_fk" FOREIGN KEY ("tenant_id", "id")
    REFERENCES "party_data_keys"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "parties_tenant_created_idx" ON "parties" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "event_version" smallint NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "trace_id" text NOT NULL,
  "trace_parent" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "attempts" smallint DEFAULT 0 NOT NULL,
  "last_error" text,
  CONSTRAINT "outbox_event_id_key" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['party_data_keys','parties','outbox'] LOOP
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
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
REVOKE ALL ON tenants, party_data_keys, parties, outbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON party_data_keys, parties TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION stamp_parties_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_parties_outbox_tenant();
