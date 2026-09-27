-- Phase 59: the projections the forecast and the pipeline metrics read. Each is a function
-- of one opportunity's history, replaced with it in the same transaction, and rebuilt from
-- it by `npm run rebuild:metrics`.
CREATE TABLE "metric_states" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "opportunity_id" uuid NOT NULL,
  "sequence" integer NOT NULL CHECK ("sequence" > 0),
  "valid_from" timestamp with time zone NOT NULL,
  "valid_to" timestamp with time zone,
  "pipeline_id" uuid NOT NULL,
  "stage_id" uuid NOT NULL,
  "probability_bps" integer NOT NULL CHECK ("probability_bps" BETWEEN 0 AND 10000),
  "owner_id" uuid NOT NULL,
  "source_id" uuid,
  "amount" bigint NOT NULL CHECK ("amount" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "expected_close_on" date NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('open', 'won', 'lost')),
  "closed_on" date,
  PRIMARY KEY ("tenant_id", "opportunity_id", "sequence"),
  CONSTRAINT "metric_states_opportunity_fk" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunities"("tenant_id", "id"),
  CONSTRAINT "metric_states_interval" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
CREATE INDEX "metric_states_tenant_interval_idx" ON "metric_states" ("tenant_id", "valid_from", "valid_to");
--> statement-breakpoint
CREATE TABLE "metric_stage_visits" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "opportunity_id" uuid NOT NULL,
  "entered_sequence" integer NOT NULL CHECK ("entered_sequence" > 0),
  "pipeline_id" uuid NOT NULL,
  "stage_id" uuid NOT NULL,
  "entered_at" timestamp with time zone NOT NULL,
  "left_at" timestamp with time zone,
  "exit" text CHECK ("exit" IN ('moved', 'won', 'lost')),
  "to_stage_id" uuid,
  PRIMARY KEY ("tenant_id", "opportunity_id", "entered_sequence"),
  CONSTRAINT "metric_stage_visits_opportunity_fk" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunities"("tenant_id", "id"),
  CONSTRAINT "metric_stage_visits_exit" CHECK (("left_at" IS NULL) = ("exit" IS NULL) AND ("exit" = 'moved') = ("to_stage_id" IS NOT NULL))
);
CREATE INDEX "metric_stage_visits_tenant_pipeline_idx" ON "metric_stage_visits" ("tenant_id", "pipeline_id", "entered_at");
--> statement-breakpoint
CREATE TABLE "metric_closures" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "opportunity_id" uuid NOT NULL,
  "sequence" integer NOT NULL CHECK ("sequence" > 0),
  "outcome" text NOT NULL CHECK ("outcome" IN ('won', 'lost')),
  "recorded_at" timestamp with time zone NOT NULL,
  "closed_on" date NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "stage_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "source_id" uuid,
  "loss_reason_id" uuid,
  "superseded_at" timestamp with time zone,
  PRIMARY KEY ("tenant_id", "opportunity_id", "sequence"),
  CONSTRAINT "metric_closures_opportunity_fk" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunities"("tenant_id", "id"),
  CONSTRAINT "metric_closures_reason" CHECK (("outcome" = 'lost') = ("loss_reason_id" IS NOT NULL))
);
CREATE INDEX "metric_closures_tenant_pipeline_idx" ON "metric_closures" ("tenant_id", "pipeline_id", "recorded_at");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['metric_states','metric_stage_visits','metric_closures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
REVOKE ALL ON metric_states, metric_stage_visits, metric_closures FROM horizon_app, horizon_relay;
-- Projections, not history: an opportunity's rows are replaced whole.
GRANT SELECT, INSERT, DELETE ON metric_states, metric_stage_visits, metric_closures TO horizon_app;
--> statement-breakpoint
-- A closed cutoff cannot change: the history takes a fact only near the database clock, so
-- nothing recorded later can claim an instant before a settled cutoff (Phase 59).
CREATE FUNCTION reject_backdated_opportunity_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF abs(extract(epoch FROM (NEW.occurred_at - clock_timestamp()))) > 120 THEN
    RAISE EXCEPTION 'an opportunity fact is recorded at the instant it happens (occurred_at % is too far from now)', NEW.occurred_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_events_recorded_now BEFORE INSERT ON opportunity_events
  FOR EACH ROW EXECUTE FUNCTION reject_backdated_opportunity_fact();
