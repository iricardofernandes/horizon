CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every event of the journaled modules, kept once by event id (ADR 0058). Projections are
-- functions of this table: a rebuild replays it, never the broker.
CREATE TABLE "event_journal" (
  "source_module" text NOT NULL CHECK ("source_module" IN ('catalog', 'crm', 'financial', 'fiscal', 'inventory', 'ledger', 'procurement', 'sales', 'treasury')),
  "event_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_type" text NOT NULL CHECK (split_part("event_type", '.', 1) = "source_module"),
  "event_version" smallint NOT NULL CHECK ("event_version" > 0),
  "occurred_at" timestamp with time zone NOT NULL,
  "trace_id" text NOT NULL,
  "payload" jsonb NOT NULL CHECK (jsonb_typeof("payload") = 'object'),
  "arrival" text NOT NULL CHECK ("arrival" IN ('live', 'replay')),
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_module", "event_id")
);
--> statement-breakpoint
CREATE INDEX "event_journal_tenant_source_idx" ON "event_journal" ("tenant_id", "source_module", "occurred_at");
--> statement-breakpoint
-- Every seal a producer sent, matched or not, so a gap stays visible.
CREATE TABLE "source_seals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "source_module" text NOT NULL CHECK ("source_module" IN ('catalog', 'crm', 'financial', 'fiscal', 'inventory', 'ledger', 'procurement', 'sales', 'treasury')),
  "through" timestamp with time zone NOT NULL,
  "producer_count" integer NOT NULL CHECK ("producer_count" >= 0),
  "journal_count" integer NOT NULL CHECK ("journal_count" >= 0),
  "outcome" text NOT NULL CHECK ("outcome" IN ('matched', 'mismatched', 'refused')),
  "sealed_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  CONSTRAINT "source_seals_match" CHECK ("outcome" <> 'matched' OR "producer_count" = "journal_count")
);
--> statement-breakpoint
CREATE INDEX "source_seals_tenant_source_idx" ON "source_seals" ("tenant_id", "source_module", "received_at");
--> statement-breakpoint
-- How far each source is proven complete for a tenant. Moved only by a matched seal.
CREATE TABLE "source_watermarks" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "source_module" text NOT NULL CHECK ("source_module" IN ('catalog', 'crm', 'financial', 'fiscal', 'inventory', 'ledger', 'procurement', 'sales', 'treasury')),
  "through" timestamp with time zone NOT NULL,
  "seal_id" uuid NOT NULL REFERENCES "source_seals"("id"),
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "source_module")
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO horizon_app;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['event_journal','source_seals','source_watermarks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, event_journal, source_seals, source_watermarks FROM horizon_app;
GRANT SELECT, INSERT ON tenants TO horizon_app;
GRANT SELECT, INSERT ON event_journal TO horizon_app;
GRANT SELECT, INSERT ON source_seals TO horizon_app;
GRANT SELECT, INSERT ON source_watermarks TO horizon_app;
GRANT UPDATE ("through", "seal_id", "updated_at") ON source_watermarks TO horizon_app;
--> statement-breakpoint
-- The journal and the seals are history: nothing rewrites or removes them (ADR 0058, 0063).
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER event_journal_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON event_journal
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER source_seals_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON source_seals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
--> statement-breakpoint
-- A watermark never moves back.
CREATE FUNCTION reject_watermark_regression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.through < OLD.through THEN RAISE EXCEPTION 'a watermark never moves back'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_watermarks_forward BEFORE UPDATE ON source_watermarks
  FOR EACH ROW EXECUTE FUNCTION reject_watermark_regression();
