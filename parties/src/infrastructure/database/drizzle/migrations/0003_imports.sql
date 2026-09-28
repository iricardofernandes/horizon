-- Bulk import jobs (ADR 0059): a job per uploaded file, a row per line of it.
CREATE TABLE "import_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" ~ '^[a-z][a-z0-9-]{0,39}$'),
  "job_key" text NOT NULL CHECK (char_length("job_key") BETWEEN 1 AND 200),
  "status" text NOT NULL CHECK ("status" IN ('uploaded', 'validated', 'previewed', 'running',
    'completed', 'completed-with-failures', 'cancelled')),
  "file_name" text NOT NULL CHECK (char_length("file_name") BETWEEN 1 AND 255),
  "format" text NOT NULL CHECK ("format" IN ('csv', 'xlsx')),
  "locale" text NOT NULL CHECK ("locale" IN ('pt-BR', 'en')),
  "delimiter" text NOT NULL CHECK ("delimiter" IN (';', ',', E'\t')),
  "sha256" text NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "columns" jsonb NOT NULL,
  "mapping" jsonb,
  "requested_by" text NOT NULL,
  -- Seals the rows' values, which are personal data here (ADR 0026). Destroyed when the
  -- job's failures expire, so what was cleared cannot be read back from a backup.
  "data_key" text,
  "validated_at" timestamp with time zone,
  "lease_until" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "failures_until" timestamp with time zone,
  "purged_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "import_jobs_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "import_jobs_tenant_kind_job_key_key" UNIQUE ("tenant_id", "kind", "job_key")
);
--> statement-breakpoint
CREATE INDEX "import_jobs_tenant_created_idx" ON "import_jobs" ("tenant_id", "created_at");
CREATE INDEX "import_jobs_running_idx" ON "import_jobs" ("lease_until") WHERE "status" = 'running';
--> statement-breakpoint
CREATE TABLE "import_rows" (
  "tenant_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "line" integer NOT NULL CHECK ("line" >= 2),
  "state" text NOT NULL CHECK ("state" IN ('pending', 'valid', 'invalid', 'written', 'rejected',
    'cancelled')),
  -- The source cells; null once retention has cleared them.
  "cells" text,
  "issues" jsonb NOT NULL DEFAULT '[]',
  "reference" text,
  PRIMARY KEY ("tenant_id", "job_id", "line"),
  CONSTRAINT "import_rows_job_fk" FOREIGN KEY ("tenant_id", "job_id")
    REFERENCES "import_jobs"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "import_rows_job_state_idx" ON "import_rows" ("tenant_id", "job_id", "state", "line");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['import_jobs','import_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON import_jobs, import_rows FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON import_jobs, import_rows TO horizon_app;
-- The worker asks, as the relay role, only which tenants have import work: never a file
-- name, a mapping or a row.
GRANT SELECT ("tenant_id", "status", "lease_until", "failures_until", "purged_at", "updated_at")
  ON import_jobs TO horizon_relay;
CREATE POLICY relay_scan ON import_jobs FOR SELECT TO horizon_relay USING (true);
