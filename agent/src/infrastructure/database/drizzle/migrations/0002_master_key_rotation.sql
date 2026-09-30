-- Master key rotation (Phase 81): each person key names the master key that wraps it, so the
-- rewrap worker can find the ones still under a key being retired.
ALTER TABLE "assistant_keys" ADD COLUMN "master_key_id" text;
--> statement-breakpoint
CREATE INDEX "assistant_keys_master_key_idx" ON "assistant_keys" ("master_key_id");
--> statement-breakpoint
GRANT UPDATE ("wrapped_key", "master_key_id") ON assistant_keys TO horizon_app;
--> statement-breakpoint
-- Across tenants, person keys are visible to the migration role only through the function
-- below, which returns tenants and counts and never a key.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY master_key_scan ON assistant_keys FOR SELECT TO %I USING (true)', current_user);
END $$;
--> statement-breakpoint
CREATE FUNCTION tenants_on_old_master_keys(current_key text) RETURNS TABLE (tenant_id uuid, keys bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.tenant_id, count(*) FROM assistant_keys k
  WHERE k.master_key_id IS DISTINCT FROM current_key
  GROUP BY k.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_on_old_master_keys(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenants_on_old_master_keys(text) TO horizon_app;
