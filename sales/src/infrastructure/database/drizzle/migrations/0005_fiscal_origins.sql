CREATE TABLE "fiscal_origins" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "origin_module" text NOT NULL,
  "document_type" text NOT NULL,
  "document_id" uuid NOT NULL,
  "purpose" text NOT NULL CHECK ("purpose" IN ('original', 'return')),
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "fiscal_origins_one_request_key" UNIQUE("tenant_id", "origin_module", "document_type", "document_id", "purpose")
);
--> statement-breakpoint
ALTER TABLE "fiscal_origins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_origins" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "fiscal_origins" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON "fiscal_origins" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "fiscal_origins" TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_sales_fiscal_origin_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fiscal origins are append-only'; END $$;
CREATE TRIGGER fiscal_origin_immutable BEFORE UPDATE OR DELETE ON "fiscal_origins"
  FOR EACH ROW EXECUTE FUNCTION reject_sales_fiscal_origin_mutation();
