-- The document index (ADR 0067, ADR 0068, Phase 74). pgvector is not a trusted extension:
-- a superuser creates it with the database (infra/postgres/init), never this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'the vector extension must be created by a superuser before this migration';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One row per attachment, kept after deletion as its tombstone: a late or replayed
-- `files.attachment.available` finds `deleted` and is refused.
CREATE TABLE "documents" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "attachment_id" uuid NOT NULL,
  "module" text NOT NULL,
  "record_type" text NOT NULL,
  "record_id" uuid NOT NULL,
  "content_type" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('pending', 'indexing', 'indexed', 'no-text', 'failed', 'deleted')),
  "deletion_reason" text,
  "digest" text CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "index_version" text,
  "chunks" integer DEFAULT 0 NOT NULL CHECK ("chunks" >= 0),
  "truncated" boolean DEFAULT false NOT NULL,
  "wrapped_key" text,
  "attempts" integer DEFAULT 0 NOT NULL CHECK ("attempts" >= 0),
  "due_at" timestamp with time zone,
  "last_error" text CHECK (char_length("last_error") <= 200),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "indexed_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  PRIMARY KEY ("tenant_id", "attachment_id"),
  -- A deleted document keeps no key and no due work: nothing can open or index it again.
  CONSTRAINT "documents_deleted" CHECK ("state" <> 'deleted' OR ("wrapped_key" IS NULL AND "due_at" IS NULL AND "deleted_at" IS NOT NULL)),
  CONSTRAINT "documents_indexed" CHECK ("state" <> 'indexed' OR ("wrapped_key" IS NOT NULL AND "index_version" IS NOT NULL AND "digest" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "documents_due_idx" ON "documents" ("due_at") WHERE "due_at" IS NOT NULL;
--> statement-breakpoint
-- The chunks, one partition per tenant (ADR 0067): each partition has its own HNSW index,
-- so a search in one tenant is planned onto that tenant's vectors alone.
CREATE TABLE "chunks" (
  "tenant_id" uuid NOT NULL,
  "attachment_id" uuid NOT NULL,
  "ordinal" integer NOT NULL CHECK ("ordinal" >= 0),
  "module" text NOT NULL,
  "record_type" text NOT NULL,
  "record_id" uuid NOT NULL,
  "sealed_text" bytea NOT NULL,
  "embedding" vector(384) NOT NULL,
  "index_version" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "attachment_id", "ordinal")
) PARTITION BY LIST ("tenant_id");
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_module", "event_id")
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['documents','chunks','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, documents, chunks, inbox FROM horizon_app, horizon_relay;
--> statement-breakpoint
GRANT SELECT, INSERT ON tenants TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON documents TO horizon_app;
--> statement-breakpoint
GRANT UPDATE ("content_type", "state", "deletion_reason", "digest", "index_version", "chunks", "truncated", "wrapped_key", "attempts", "due_at", "last_error", "updated_at", "indexed_at", "deleted_at") ON documents TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON chunks TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON inbox TO horizon_app;
--> statement-breakpoint
-- The worker finds its tenants as the relay role, which reads when and what, never content.
GRANT SELECT ("tenant_id", "due_at", "state", "index_version") ON documents TO horizon_relay;
--> statement-breakpoint
CREATE POLICY relay_scan ON documents FOR SELECT TO horizon_relay USING (true);
--> statement-breakpoint
-- A tenant's partition, created on first use by the migration role (the application role
-- holds no DDL). It serves only the tenant of the current transaction, carries its own
-- HNSW index and forced RLS, and is reachable only through the parent table.
CREATE FUNCTION ensure_chunk_partition(tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  partition text := 'chunks_' || replace(tenant::text, '-', '');
BEGIN
  IF tenant IS DISTINCT FROM current_setting('app.current_tenant', true)::uuid THEN
    RAISE EXCEPTION 'a partition is created only for the tenant of the transaction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(partition, 0));
  IF to_regclass(partition) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format('CREATE TABLE %I PARTITION OF chunks FOR VALUES IN (%L)', partition, tenant);
  EXECUTE format('CREATE INDEX %I ON %I USING hnsw (embedding vector_cosine_ops)', partition || '_hnsw', partition);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', partition);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, horizon_app, horizon_relay', partition);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ensure_chunk_partition(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ensure_chunk_partition(uuid) TO horizon_app;
