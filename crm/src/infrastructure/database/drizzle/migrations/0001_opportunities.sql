-- Phase 56: pipelines, the source and loss-reason lists, and opportunities whose history
-- is the source of truth. Nothing here is deleted: stages, pipelines and list entries are
-- archived, and the opportunity history is append-only.
CREATE TABLE "pipelines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "archived" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "pipelines_tenant_id_key" UNIQUE ("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "pipeline_id" uuid NOT NULL,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "probability_bps" integer NOT NULL CHECK ("probability_bps" BETWEEN 0 AND 10000),
  "position" integer NOT NULL CHECK ("position" >= 0),
  "archived" boolean NOT NULL,
  CONSTRAINT "pipeline_stages_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "pipeline_stages_pipeline_fk" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipelines"("tenant_id", "id"),
  CONSTRAINT "pipeline_stages_position_key" UNIQUE ("pipeline_id", "position") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE "list_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('source', 'loss-reason')),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "archived" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "list_entries_tenant_id_key" UNIQUE ("tenant_id", "id")
);
--> statement-breakpoint
-- An active name is unique per list; archived entries may repeat one.
CREATE UNIQUE INDEX "list_entries_active_name_key" ON "list_entries" ("tenant_id", "kind", lower("name")) WHERE NOT "archived";
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "source_id" uuid;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_source_fk" FOREIGN KEY ("tenant_id", "source_id") REFERENCES "list_entries"("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "opportunities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 2 AND 160),
  "contact_ids" uuid[] NOT NULL,
  "owner_id" uuid NOT NULL,
  "source_id" uuid,
  "expected_amount" bigint NOT NULL CHECK ("expected_amount" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "expected_close_on" date NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "stage_id" uuid NOT NULL,
  "probability_bps" integer NOT NULL CHECK ("probability_bps" BETWEEN 0 AND 10000),
  "status" text NOT NULL CHECK ("status" IN ('open', 'won', 'lost')),
  "loss_reason_id" uuid,
  "loss_note" text CHECK (char_length("loss_note") <= 500),
  "closed_on" date,
  "version" integer NOT NULL CHECK ("version" > 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "opportunities_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "opportunities_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "opportunities_pipeline_fk" FOREIGN KEY ("tenant_id", "pipeline_id") REFERENCES "pipelines"("tenant_id", "id"),
  CONSTRAINT "opportunities_stage_fk" FOREIGN KEY ("tenant_id", "stage_id") REFERENCES "pipeline_stages"("tenant_id", "id"),
  CONSTRAINT "opportunities_source_fk" FOREIGN KEY ("tenant_id", "source_id") REFERENCES "list_entries"("tenant_id", "id"),
  CONSTRAINT "opportunities_loss_reason_fk" FOREIGN KEY ("tenant_id", "loss_reason_id") REFERENCES "list_entries"("tenant_id", "id"),
  -- A closed opportunity has its date; only a lost one has a reason.
  CONSTRAINT "opportunities_closure" CHECK (("status" = 'open') = ("closed_on" IS NULL)
    AND ("status" = 'lost') = ("loss_reason_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_board_idx" ON "opportunities" ("tenant_id", "pipeline_id", "status", "stage_id");
CREATE INDEX "opportunities_tenant_account_idx" ON "opportunities" ("tenant_id", "account_id");
CREATE INDEX "opportunities_tenant_owner_idx" ON "opportunities" ("tenant_id", "owner_id", "status");
--> statement-breakpoint
CREATE TABLE "opportunity_events" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "opportunity_id" uuid NOT NULL,
  "sequence" integer NOT NULL CHECK ("sequence" > 0),
  "type" text NOT NULL CHECK ("type" IN ('created', 'revised', 'stage-changed', 'owner-changed', 'won', 'lost', 'reopened')),
  "fact" jsonb NOT NULL,
  "actor" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "opportunity_id", "sequence"),
  CONSTRAINT "opportunity_events_opportunity_fk" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunities"("tenant_id", "id") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE FUNCTION reject_opportunity_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'opportunity history is append-only'; END $$;
CREATE TRIGGER opportunity_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON opportunity_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_opportunity_history_mutation();
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pipelines','pipeline_stages','list_entries','opportunities','opportunity_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON pipelines, pipeline_stages, list_entries, opportunities, opportunity_events FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON pipelines TO horizon_app;
GRANT UPDATE ("name", "archived", "updated_at") ON pipelines TO horizon_app;
GRANT SELECT, INSERT ON pipeline_stages TO horizon_app;
GRANT UPDATE ("name", "probability_bps", "position", "archived") ON pipeline_stages TO horizon_app;
GRANT SELECT, INSERT ON list_entries TO horizon_app;
GRANT UPDATE ("name", "archived", "updated_at") ON list_entries TO horizon_app;
GRANT SELECT, INSERT ON opportunities TO horizon_app;
GRANT UPDATE ("title", "contact_ids", "owner_id", "source_id", "expected_amount", "currency", "expected_close_on", "stage_id", "probability_bps", "status", "loss_reason_id", "loss_note", "closed_on", "version", "updated_at") ON opportunities TO horizon_app;
GRANT SELECT, INSERT ON opportunity_events TO horizon_app;
GRANT UPDATE ("source_id") ON accounts TO horizon_app;
