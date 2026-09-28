-- Consistency checks (ADR 0063, Phase 69): each run is kept as it was, never rewritten.
CREATE TABLE "consistency_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "trigger" text NOT NULL CHECK ("trigger" IN ('scheduled', 'manual')),
  "outcome" text NOT NULL CHECK ("outcome" IN ('consistent', 'inconsistent', 'incomplete')),
  "checks" jsonb NOT NULL CHECK (jsonb_typeof("checks") = 'array'),
  "pending_postings" integer CHECK ("pending_postings" IS NULL OR "pending_postings" >= 0),
  "started_by" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone NOT NULL,
  CONSTRAINT "consistency_runs_period_check" CHECK ("finished_at" >= "started_at")
);
--> statement-breakpoint
CREATE INDEX "consistency_runs_tenant_started_idx" ON "consistency_runs" ("tenant_id", "started_at" DESC);
--> statement-breakpoint
ALTER TABLE "consistency_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consistency_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "consistency_runs" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON "consistency_runs" FROM horizon_app;
GRANT SELECT, INSERT ON "consistency_runs" TO horizon_app;
CREATE TRIGGER consistency_runs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON consistency_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
--> statement-breakpoint
-- The scheduled checks find their tenants as the relay role: which tenants reporting holds
-- history for, and nothing else.
GRANT SELECT ("tenant_id") ON source_watermarks TO horizon_relay;
CREATE POLICY relay_tenant_scan ON source_watermarks FOR SELECT TO horizon_relay USING (true);
