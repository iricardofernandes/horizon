-- A list screen's filters, sort and columns under a name (Phase 66). Presentation state,
-- not a business fact (ADR 0058 §4).
CREATE TABLE "saved_views" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "screen" text NOT NULL CHECK ("screen" ~ '^[a-z][a-z-]*\.[a-z][a-z-]*$'),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "query" text NOT NULL CHECK (char_length("query") <= 1000),
  "columns" jsonb CHECK ("columns" IS NULL OR jsonb_typeof("columns") = 'array'),
  "owner_id" text NOT NULL,
  "shared" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "saved_views_owner_name_key" UNIQUE ("tenant_id", "owner_id", "screen", "name")
);
--> statement-breakpoint
CREATE INDEX "saved_views_tenant_screen_idx" ON "saved_views" ("tenant_id", "screen");
--> statement-breakpoint
-- What needs a person's attention, told once: unique on the fact it tells and whom.
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('task-due', 'approval-requisition', 'approval-order', 'approval-payable', 'import-finished', 'billing-run-finished', 'file-quarantined', 'export-finished', 'reconciliation-different')),
  "source_id" text NOT NULL,
  "recipient" text NOT NULL,
  "recipient_user" text,
  "recipient_module" text,
  "recipient_roles" text[],
  "except_user" text,
  "params" jsonb NOT NULL CHECK (jsonb_typeof("params") = 'object'),
  "link" text CHECK ("link" IS NULL OR "link" ~ '^/app/'),
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "notifications_recipient" CHECK (
    ("recipient_user" IS NOT NULL AND "recipient_module" IS NULL AND "recipient_roles" IS NULL)
    OR ("recipient_user" IS NULL AND "recipient_module" IS NOT NULL AND cardinality("recipient_roles") > 0)),
  CONSTRAINT "notifications_once_key" UNIQUE ("tenant_id", "source_id", "kind", "recipient")
);
--> statement-breakpoint
CREATE INDEX "notifications_tenant_user_idx" ON "notifications" ("tenant_id", "recipient_user", "created_at");
CREATE INDEX "notifications_tenant_module_idx" ON "notifications" ("tenant_id", "recipient_module", "created_at");
--> statement-breakpoint
-- Read state is per person, even for a notification addressed to a role.
CREATE TABLE "notification_reads" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "notification_id" uuid NOT NULL REFERENCES "notifications"("id"),
  "user_id" text NOT NULL,
  "read_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("notification_id", "user_id")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['saved_views','notifications','notification_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON saved_views, notifications, notification_reads FROM horizon_app;
GRANT SELECT, INSERT, DELETE ON saved_views TO horizon_app;
GRANT UPDATE ("name", "query", "columns", "shared", "updated_at") ON saved_views TO horizon_app;
GRANT SELECT, INSERT ON notifications TO horizon_app;
GRANT SELECT, INSERT ON notification_reads TO horizon_app;
--> statement-breakpoint
-- A notification is a record of what was told: it is never rewritten.
CREATE TRIGGER notifications_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
