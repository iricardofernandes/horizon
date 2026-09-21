-- Expand: old rows stay incomplete until an operator verifies structured fiscal fields.
ALTER TABLE "parties" ADD COLUMN "fiscal_profile_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "fiscal_profile_revision" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_fiscal_profile_revision_valid" CHECK ("fiscal_profile_revision" >= 0);
--> statement-breakpoint
CREATE TABLE "party_fiscal_profiles" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "party_id" uuid NOT NULL,
  "revision" smallint NOT NULL CHECK ("revision" > 0),
  "effective_from" text NOT NULL,
  "ciphertext" text NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "party_fiscal_profiles_revision_key" UNIQUE("tenant_id", "party_id", "revision"),
  CONSTRAINT "party_fiscal_profiles_party_fk" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "parties"("tenant_id", "id")
);
--> statement-breakpoint
ALTER TABLE "party_fiscal_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_fiscal_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "party_fiscal_profiles" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON "party_fiscal_profiles" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "party_fiscal_profiles" TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_party_fiscal_profile_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'party fiscal profile history is append-only';
END $$;
CREATE TRIGGER party_fiscal_profile_immutable BEFORE UPDATE OR DELETE ON "party_fiscal_profiles"
  FOR EACH ROW EXECUTE FUNCTION reject_party_fiscal_profile_mutation();
