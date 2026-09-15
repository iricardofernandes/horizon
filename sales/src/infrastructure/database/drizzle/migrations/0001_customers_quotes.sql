CREATE TABLE "customer_data_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "material" text,
  "erased_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "customer_data_keys_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "customer_data_keys_erasure_check" CHECK (
    (material IS NOT NULL AND erased_at IS NULL) OR (material IS NULL AND erased_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name_ciphertext" text NOT NULL,
  "tax_id_ciphertext" text NOT NULL,
  "tax_id_index" text NOT NULL,
  "email_ciphertext" text NOT NULL,
  "phone_ciphertext" text NOT NULL,
  "address_ciphertext" text NOT NULL,
  "status" text NOT NULL CHECK (status IN ('active', 'erased')),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "customers_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "customers_tenant_tax_id_index_key" UNIQUE("tenant_id", "tax_id_index"),
  CONSTRAINT "customers_tenant_data_key_fk" FOREIGN KEY ("tenant_id", "id") REFERENCES "customer_data_keys"("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "customer_id" uuid NOT NULL,
  "status" text NOT NULL CHECK (status IN ('draft', 'accepted', 'expired')),
  "total" bigint NOT NULL CHECK (total >= 0),
  "currency" text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "quotes_expiry_check" CHECK (expires_at > created_at),
  CONSTRAINT "quotes_tenant_id_key" UNIQUE("tenant_id", "id"),
  CONSTRAINT "quotes_tenant_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "quote_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK (quantity > 0),
  "description" text NOT NULL,
  "unit_price" bigint NOT NULL CHECK (unit_price >= 0),
  "line_total" bigint NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY ("tenant_id", "quote_id", "line_id"),
  CONSTRAINT "quote_lines_tenant_quote_item_key" UNIQUE("tenant_id", "quote_id", "item_id"),
  CONSTRAINT "quote_lines_quote_fk" FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quotes"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "quotes_tenant_customer_idx" ON "quotes" ("tenant_id", "customer_id", "created_at");
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['customer_data_keys','customers','quotes','quote_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON customer_data_keys, customers, quotes, quote_lines FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON customer_data_keys, customers, quotes, quote_lines TO horizon_app;
