-- Phase 57: activities, tasks and notes around an account. Their free text is sealed
-- under a key of the account, destroyed with its party (ADR 0026); note revisions are
-- append-only. Nothing here is deleted.
CREATE TABLE "account_data_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "material" text,
  "erased_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "account_data_keys_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "account_data_keys_account_fk" FOREIGN KEY ("tenant_id", "id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "account_data_keys_erasure" CHECK (("material" IS NULL) = ("erased_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION reject_account_key_restore() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.material IS NULL AND NEW.material IS NOT NULL THEN RAISE EXCEPTION 'an erased account key cannot be restored'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_keys_stay_erased BEFORE UPDATE ON account_data_keys
  FOR EACH ROW EXECUTE FUNCTION reject_account_key_restore();
--> statement-breakpoint
CREATE TABLE "activities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "subject_type" text NOT NULL CHECK ("subject_type" IN ('account', 'contact', 'opportunity')),
  "subject_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('call', 'meeting', 'email', 'visit')),
  "occurred_at" timestamp with time zone NOT NULL,
  "title_ciphertext" text NOT NULL,
  "summary_ciphertext" text,
  "contact_ids" uuid[] NOT NULL CHECK (cardinality("contact_ids") <= 20),
  "recorded_by" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "activities_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "activities_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "activities_account_subject" CHECK ("subject_type" <> 'account' OR "subject_id" = "account_id")
);
--> statement-breakpoint
CREATE INDEX "activities_tenant_account_idx" ON "activities" ("tenant_id", "account_id", "occurred_at");
CREATE INDEX "activities_tenant_subject_idx" ON "activities" ("tenant_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "subject_type" text NOT NULL CHECK ("subject_type" IN ('account', 'contact', 'opportunity')),
  "subject_id" uuid NOT NULL,
  "title_ciphertext" text NOT NULL,
  "assignee_id" uuid NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "remind_at" timestamp with time zone,
  "reminded_at" timestamp with time zone,
  "status" text NOT NULL CHECK ("status" IN ('open', 'completed', 'cancelled')),
  "created_by" text NOT NULL,
  "closed_by" text,
  "closed_at" timestamp with time zone,
  "version" integer NOT NULL CHECK ("version" > 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "tasks_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "tasks_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "tasks_account_subject" CHECK ("subject_type" <> 'account' OR "subject_id" = "account_id"),
  CONSTRAINT "tasks_reminder_before_due" CHECK ("remind_at" IS NULL OR "remind_at" <= "due_at"),
  CONSTRAINT "tasks_reminded_needs_reminder" CHECK ("reminded_at" IS NULL OR "remind_at" IS NOT NULL),
  CONSTRAINT "tasks_closure" CHECK (("status" = 'open') = ("closed_at" IS NULL)
    AND ("closed_at" IS NULL) = ("closed_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "tasks_tenant_account_idx" ON "tasks" ("tenant_id", "account_id", "created_at");
CREATE INDEX "tasks_tenant_subject_idx" ON "tasks" ("tenant_id", "subject_type", "subject_id");
CREATE INDEX "tasks_tenant_agenda_idx" ON "tasks" ("tenant_id", "assignee_id", "due_at") WHERE "status" = 'open';
-- What the scheduler scans: armed reminders only, across tenants.
CREATE INDEX "tasks_armed_reminders_idx" ON "tasks" ("remind_at") WHERE "status" = 'open' AND "reminded_at" IS NULL AND "remind_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "notes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "subject_type" text NOT NULL CHECK ("subject_type" IN ('account', 'contact', 'opportunity')),
  "subject_id" uuid NOT NULL,
  "current_revision" integer NOT NULL CHECK ("current_revision" > 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "notes_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "notes_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "notes_account_subject" CHECK ("subject_type" <> 'account' OR "subject_id" = "account_id")
);
--> statement-breakpoint
CREATE INDEX "notes_tenant_account_idx" ON "notes" ("tenant_id", "account_id", "created_at");
CREATE INDEX "notes_tenant_subject_idx" ON "notes" ("tenant_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE TABLE "note_revisions" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "note_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "body_ciphertext" text NOT NULL,
  "author" text NOT NULL,
  "written_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "note_id", "revision"),
  CONSTRAINT "note_revisions_note_fk" FOREIGN KEY ("tenant_id", "note_id") REFERENCES "notes"("tenant_id", "id") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE FUNCTION reject_note_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'note revisions are append-only'; END $$;
CREATE TRIGGER note_revisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON note_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_note_revision_mutation();
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['account_data_keys','activities','tasks','notes','note_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON account_data_keys, activities, tasks, notes, note_revisions FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON account_data_keys TO horizon_app;
GRANT UPDATE ("material", "erased_at") ON account_data_keys TO horizon_app;
GRANT SELECT, INSERT ON activities TO horizon_app;
GRANT UPDATE ("kind", "occurred_at", "title_ciphertext", "summary_ciphertext", "contact_ids", "version", "updated_at") ON activities TO horizon_app;
GRANT SELECT, INSERT ON tasks TO horizon_app;
GRANT UPDATE ("title_ciphertext", "assignee_id", "due_at", "remind_at", "reminded_at", "status", "closed_by", "closed_at", "version", "updated_at") ON tasks TO horizon_app;
GRANT SELECT, INSERT ON notes TO horizon_app;
GRANT UPDATE ("current_revision", "updated_at") ON notes TO horizon_app;
GRANT SELECT, INSERT ON note_revisions TO horizon_app;
--> statement-breakpoint
-- The reminder scheduler asks, across tenants, only which workspaces have a reminder to
-- send: four columns, never a title (Phase 57). Sending happens as horizon_app, per tenant.
GRANT SELECT ("tenant_id", "status", "remind_at", "reminded_at") ON tasks TO horizon_relay;
CREATE POLICY reminder_scan ON tasks FOR SELECT TO horizon_relay USING (true);
