-- Reports are queries over the journal at a cutoff (Phase 62): nothing here holds a
-- figure. What is stored is what people did with them.
CREATE TABLE "saved_filters" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "report" text NOT NULL CHECK ("report" IN ('cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue')),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "filter" jsonb NOT NULL CHECK (jsonb_typeof("filter") = 'object'),
  "owner_id" text NOT NULL,
  "shared" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "saved_filters_tenant_report_idx" ON "saved_filters" ("tenant_id", "report", "name");
--> statement-breakpoint
-- A reconciliation run and every check it made, differences included. History: never
-- rewritten.
CREATE TABLE "reconciliation_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "report" text NOT NULL CHECK ("report" IN ('cash-position', 'order-to-cash', 'procure-to-pay', 'pipeline-to-revenue')),
  "cutoff" timestamp with time zone NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('matched', 'different', 'not-comparable')),
  "checks" jsonb NOT NULL CHECK (jsonb_typeof("checks") = 'array'),
  "started_by" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reconciliation_runs_tenant_report_idx" ON "reconciliation_runs" ("tenant_id", "report", "cutoff", "started_at");
--> statement-breakpoint
CREATE TABLE "command_receipts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 8 AND 255),
  "command" text NOT NULL,
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "actor" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "action" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "request_id" text,
  "trace_id" text,
  "details" jsonb NOT NULL,
  "previous_hash" text NOT NULL,
  "hash" text NOT NULL,
  CONSTRAINT "audit_log_tenant_sequence_key" UNIQUE ("tenant_id", "sequence")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['saved_filters','reconciliation_runs','command_receipts','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON saved_filters, reconciliation_runs, command_receipts, audit_log FROM horizon_app;
GRANT SELECT, INSERT, DELETE ON saved_filters TO horizon_app;
GRANT UPDATE ("name", "filter", "shared", "updated_at") ON saved_filters TO horizon_app;
GRANT SELECT, INSERT ON reconciliation_runs TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON reconciliation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
