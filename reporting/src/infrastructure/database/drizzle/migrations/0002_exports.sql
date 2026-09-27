-- A report asked for as a file (Phase 63). The row stays after its file expires, as history.
CREATE TABLE "export_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "requested_by" text NOT NULL,
  "report" text NOT NULL CHECK ("report" IN ('cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue')),
  "filter" jsonb NOT NULL CHECK (jsonb_typeof("filter") = 'object'),
  "cutoff" timestamp with time zone NOT NULL,
  "format" text NOT NULL CHECK ("format" IN ('csv', 'xlsx')),
  "locale" text NOT NULL CHECK ("locale" IN ('pt-BR', 'en')),
  -- No foreign key: a removed schedule keeps the runs it made.
  "schedule_id" uuid,
  "status" text NOT NULL CHECK ("status" IN ('requested', 'running', 'ready', 'failed', 'expired')),
  "settled" boolean,
  "rows" integer CHECK ("rows" >= 0),
  "bytes" integer CHECK ("bytes" >= 0),
  "sha256" text CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "object_key" text,
  "failure" text,
  "requested_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  CONSTRAINT "export_jobs_ready" CHECK ("status" <> 'ready' OR ("object_key" IS NOT NULL AND "sha256" IS NOT NULL AND "expires_at" IS NOT NULL)),
  CONSTRAINT "export_jobs_expired" CHECK ("status" <> 'expired' OR "object_key" IS NULL)
);
--> statement-breakpoint
-- A scheduled run is made once per schedule and cutoff, however often the worker looks.
CREATE UNIQUE INDEX "export_jobs_schedule_cutoff_key" ON "export_jobs" ("schedule_id", "cutoff") WHERE "schedule_id" IS NOT NULL;
CREATE INDEX "export_jobs_tenant_requested_idx" ON "export_jobs" ("tenant_id", "requested_at");
CREATE INDEX "export_jobs_work_idx" ON "export_jobs" ("status", "requested_at") WHERE "status" IN ('requested', 'running', 'ready');
--> statement-breakpoint
CREATE TABLE "export_schedules" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "owner_id" text NOT NULL,
  "report" text NOT NULL CHECK ("report" IN ('cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue')),
  "filter" jsonb NOT NULL CHECK (jsonb_typeof("filter") = 'object'),
  "format" text NOT NULL CHECK ("format" IN ('csv', 'xlsx')),
  "locale" text NOT NULL CHECK ("locale" IN ('pt-BR', 'en')),
  "cadence" text NOT NULL CHECK ("cadence" IN ('daily', 'weekly', 'monthly')),
  "time_zone" text NOT NULL,
  "next_due_at" timestamp with time zone NOT NULL,
  "active" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "export_schedules_due_idx" ON "export_schedules" ("next_due_at") WHERE "active";
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['export_jobs','export_schedules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON export_jobs, export_schedules FROM horizon_app;
GRANT SELECT, INSERT ON export_jobs TO horizon_app;
GRANT UPDATE ("status", "settled", "rows", "bytes", "sha256", "object_key", "failure", "started_at", "finished_at", "expires_at") ON export_jobs TO horizon_app;
GRANT SELECT, INSERT, DELETE ON export_schedules TO horizon_app;
GRANT UPDATE ("next_due_at", "active", "updated_at") ON export_schedules TO horizon_app;
--> statement-breakpoint
-- The worker asks, as the relay role, only which tenants have work: never a report, a
-- filter or who asked (the CRM reminder pattern, Phase 57).
GRANT USAGE ON SCHEMA public TO horizon_relay;
GRANT SELECT ("tenant_id", "status", "started_at", "expires_at") ON export_jobs TO horizon_relay;
GRANT SELECT ("tenant_id", "active", "next_due_at") ON export_schedules TO horizon_relay;
CREATE POLICY relay_scan ON export_jobs FOR SELECT TO horizon_relay USING (true);
CREATE POLICY relay_scan ON export_schedules FOR SELECT TO horizon_relay USING (true);
