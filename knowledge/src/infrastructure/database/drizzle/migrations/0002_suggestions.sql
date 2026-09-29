-- Suggestions (Phase 77): the workspace's confirmed history, one partition per tenant
-- (ADR 0067), and the official NCM table, public data shared by every workspace.
CREATE TABLE "examples" (
  "tenant_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('ncm', 'payable-category')),
  "source_id" uuid NOT NULL,
  -- An item's NCM, or null while it has none: `classification-changed` carries no name, so
  -- every item is kept, and only a labelled one votes.
  "label" text CHECK (char_length("label") BETWEEN 1 AND 64),
  -- The supplier a payable example came from: erasing it removes the example (ADR 0068).
  "party_id" uuid,
  -- What the reason shows: an item's name and SKU, a payable's document number.
  "reference" text NOT NULL CHECK (char_length("reference") <= 240),
  "embedding" vector(384) NOT NULL,
  "index_version" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "kind", "source_id"),
  CONSTRAINT "examples_payable_labelled" CHECK ("kind" <> 'payable-category' OR "label" IS NOT NULL)
) PARTITION BY LIST ("tenant_id");
--> statement-breakpoint
ALTER TABLE examples ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE examples FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON examples TO horizon_app USING (tenant_id = current_setting('app.current_tenant')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON examples FROM horizon_app, horizon_relay;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON examples TO horizon_app;
--> statement-breakpoint
-- A tenant's partition of examples, created on first use as `ensure_chunk_partition` does.
CREATE FUNCTION ensure_example_partition(tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  partition text := 'examples_' || replace(tenant::text, '-', '');
BEGIN
  IF tenant IS DISTINCT FROM current_setting('app.current_tenant', true)::uuid THEN
    RAISE EXCEPTION 'a partition is created only for the tenant of the transaction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(partition, 0));
  IF to_regclass(partition) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format('CREATE TABLE %I PARTITION OF examples FOR VALUES IN (%L)', partition, tenant);
  EXECUTE format('CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops)', partition || '_hnsw', partition);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', partition);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, horizon_app, horizon_relay', partition);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ensure_example_partition(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ensure_example_partition(uuid) TO horizon_app;
--> statement-breakpoint
-- The official table: no tenant, the same rows for everyone, read by any workspace.
CREATE TABLE "ncm_codes" (
  "code" text PRIMARY KEY NOT NULL CHECK ("code" ~ '^\d{8}$'),
  "description" text NOT NULL,
  "embedding" vector(384) NOT NULL,
  "index_version" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ncm_codes_hnsw" ON "ncm_codes" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- Which table, embedded by which model, is loaded: a new one of either loads it again.
CREATE TABLE "ncm_table_state" (
  "id" boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "act" text NOT NULL,
  "index_version" text NOT NULL,
  "codes" integer NOT NULL,
  "loaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON ncm_codes, ncm_table_state FROM horizon_app, horizon_relay;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON ncm_codes TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ncm_table_state TO horizon_app;
