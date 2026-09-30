-- Master key rotation (Phase 81): each document key names the master key that wraps it, so the
-- rewrap worker can find the ones still under a key being retired.
ALTER TABLE "documents" ADD COLUMN "master_key_id" text;
--> statement-breakpoint
CREATE INDEX "documents_master_key_idx" ON "documents" ("master_key_id") WHERE "wrapped_key" IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE ("master_key_id") ON documents TO horizon_app;
--> statement-breakpoint
-- Across tenants, only rows that hold a key are visible to the migration role, and only
-- through the function below, which returns tenants and counts and never a key.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY master_key_scan ON documents FOR SELECT TO %I USING (wrapped_key IS NOT NULL)', current_user);
END $$;
--> statement-breakpoint
CREATE FUNCTION tenants_on_old_master_keys(current_key text) RETURNS TABLE (tenant_id uuid, keys bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.tenant_id, count(*) FROM documents d
  WHERE d.wrapped_key IS NOT NULL AND d.master_key_id IS DISTINCT FROM current_key
  GROUP BY d.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_on_old_master_keys(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenants_on_old_master_keys(text) TO horizon_app;
