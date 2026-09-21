-- Expand: legacy company rows remain revision 0 until the owner reaffirms their fiscal data.
ALTER TABLE "tenants" ADD COLUMN "fiscal_profile_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "fiscal_profile_effective_from" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_fiscal_profile_revision_valid" CHECK ("fiscal_profile_revision" >= 0);
--> statement-breakpoint
CREATE TABLE "company_profile_keys" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id"),
  "material" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_profile_versions" (
  "tenant_id" uuid NOT NULL REFERENCES "company_profile_keys"("tenant_id"),
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "effective_from" text NOT NULL,
  "ciphertext" text NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "company_profile_versions_revision_key" UNIQUE("tenant_id", "revision")
);
--> statement-breakpoint
ALTER TABLE "company_profile_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "company_profile_keys" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE "company_profile_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "company_profile_versions" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON "company_profile_keys", "company_profile_versions" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "company_profile_keys" TO horizon_app;
GRANT SELECT, INSERT ON "company_profile_versions" TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_company_profile_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'company profile history is append-only';
END $$;
CREATE TRIGGER company_profile_version_immutable BEFORE UPDATE OR DELETE ON "company_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_company_profile_version_mutation();
