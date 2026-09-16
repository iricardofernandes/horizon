CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_categories" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "nature" text NOT NULL CHECK ("nature" IN ('revenue', 'expense')),
  "parent_id" uuid,
  "depth" smallint NOT NULL CHECK ("depth" BETWEEN 1 AND 4),
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "financial_categories_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "financial_categories_tenant_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "financial_categories_parent_fk" FOREIGN KEY ("tenant_id", "parent_id")
    REFERENCES "financial_categories" ("tenant_id", "id"),
  CONSTRAINT "financial_categories_root_depth_check" CHECK (("parent_id" IS NULL) = ("depth" = 1))
);
--> statement-breakpoint
CREATE TABLE "analytic_dimensions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('department', 'project')),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "analytic_dimensions_tenant_kind_code_key" UNIQUE ("tenant_id", "kind", "code")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('cash', 'bank-transfer', 'pix', 'boleto', 'credit-card', 'debit-card', 'check', 'other')),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "payment_methods_tenant_code_key" UNIQUE ("tenant_id", "code")
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL,
  "installments" jsonb NOT NULL CHECK (jsonb_typeof("installments") = 'array' AND jsonb_array_length("installments") BETWEEN 1 AND 120),
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "payment_terms_tenant_name_key" UNIQUE ("tenant_id", "name")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['financial_categories','analytic_dimensions','payment_methods','payment_terms'] LOOP
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
REVOKE ALL ON tenants, financial_categories, analytic_dimensions, payment_methods, payment_terms FROM horizon_app;
GRANT SELECT, INSERT ON tenants TO horizon_app;
-- Registries are deactivated, never deleted: documents keep pointing at what they used.
GRANT SELECT, INSERT, UPDATE ON financial_categories, analytic_dimensions, payment_methods, payment_terms TO horizon_app;
