CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One key per owner, wrapped by the master key. Destroying `wrapped_key` is the erasure
-- (ADR 0026, ADR 0060): every file under it becomes unreadable, backups included.
CREATE TABLE "owner_keys" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "owner_type" text NOT NULL CHECK ("owner_type" IN ('party', 'user')),
  "owner_id" text NOT NULL CHECK (char_length("owner_id") BETWEEN 1 AND 128),
  "wrapped_key" text,
  "erased_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "owner_type", "owner_id"),
  CONSTRAINT "owner_keys_erasure" CHECK (("wrapped_key" IS NULL) = ("erased_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "module" text NOT NULL,
  "record_type" text NOT NULL,
  "record_id" uuid NOT NULL,
  "file_name" text NOT NULL CHECK (char_length("file_name") BETWEEN 1 AND 255),
  "content_type" text NOT NULL CHECK ("content_type" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  "size" integer NOT NULL CHECK ("size" BETWEEN 1 AND 10485760),
  "sha256" text CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "status" text NOT NULL CHECK ("status" IN ('uploading', 'scanning', 'available', 'quarantined', 'deleted')),
  "deletion_reason" text CHECK ("deletion_reason" IN ('removed', 'expired', 'erased', 'quarantined', 'abandoned')),
  "finding" text CHECK (char_length("finding") <= 200),
  "owner_type" text NOT NULL,
  "owner_id" text NOT NULL,
  "wrapped_data_key" text,
  "object_key" text,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "uploaded_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "uploaded_at" timestamp with time zone,
  "available_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "due_at" timestamp with time zone,
  "scan_attempts" integer DEFAULT 0 NOT NULL CHECK ("scan_attempts" >= 0),
  CONSTRAINT "attachments_record" CHECK (
    ("module" = 'parties' AND "record_type" = 'party')
    OR ("module" = 'procurement' AND "record_type" = 'purchase-order')
    OR ("module" = 'financial' AND "record_type" IN ('receivable', 'payable'))
    OR ("module" = 'sales' AND "record_type" = 'service-order')
    OR ("module" = 'crm' AND "record_type" = 'opportunity')),
  CONSTRAINT "attachments_owner_fk" FOREIGN KEY ("tenant_id", "owner_type", "owner_id") REFERENCES "owner_keys"("tenant_id", "owner_type", "owner_id"),
  CONSTRAINT "attachments_idempotency_key" UNIQUE ("tenant_id", "idempotency_key"),
  -- Only a scanned file is served, and a scanned file has its bytes, hash and key.
  CONSTRAINT "attachments_available" CHECK ("status" <> 'available' OR ("sha256" IS NOT NULL AND "object_key" IS NOT NULL AND "wrapped_data_key" IS NOT NULL AND "available_at" IS NOT NULL)),
  CONSTRAINT "attachments_quarantined" CHECK ("status" <> 'quarantined' OR "finding" IS NOT NULL),
  CONSTRAINT "attachments_deleted" CHECK (("status" = 'deleted') = ("deletion_reason" IS NOT NULL AND "deleted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "attachments_tenant_record_idx" ON "attachments" ("tenant_id", "module", "record_type", "record_id", "created_at");
CREATE INDEX "attachments_tenant_owner_idx" ON "attachments" ("tenant_id", "owner_type", "owner_id");
CREATE INDEX "attachments_due_idx" ON "attachments" ("due_at") WHERE "due_at" IS NOT NULL;
--> statement-breakpoint
-- Every removal of stored bytes, for whatever reason: the retention job's log. History:
-- nothing rewrites or removes it.
CREATE TABLE "attachment_removals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "attachment_id" uuid NOT NULL,
  "module" text NOT NULL,
  "record_type" text NOT NULL,
  "record_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK ("reason" IN ('removed', 'expired', 'erased', 'quarantined', 'abandoned')),
  "bytes" integer NOT NULL CHECK ("bytes" >= 0),
  "removed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attachment_removals_tenant_idx" ON "attachment_removals" ("tenant_id", "removed_at");
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
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_id" uuid NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "event_version" smallint NOT NULL CHECK (event_version > 0),
  "occurred_at" timestamptz NOT NULL,
  "trace_id" text NOT NULL,
  "trace_parent" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "dispatched_at" timestamptz,
  "attempts" smallint DEFAULT 0 NOT NULL CHECK (attempts >= 0),
  "last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
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
  FOREACH table_name IN ARRAY ARRAY['owner_keys','attachments','attachment_removals','audit_log','outbox','inbox'] LOOP
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
REVOKE ALL ON tenants, owner_keys, attachments, attachment_removals, audit_log, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
GRANT SELECT, INSERT ON owner_keys TO horizon_app;
GRANT UPDATE ("wrapped_key", "erased_at") ON owner_keys TO horizon_app;
GRANT SELECT, INSERT ON attachments TO horizon_app;
GRANT UPDATE ("sha256", "status", "deletion_reason", "finding", "wrapped_data_key", "object_key", "uploaded_at", "available_at", "expires_at", "deleted_at", "due_at", "scan_attempts") ON attachments TO horizon_app;
GRANT SELECT, INSERT ON attachment_removals TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, INSERT ON inbox TO horizon_app;
--> statement-breakpoint
-- The relay delivers the outbox, and asks only which tenants have due attachments: never a
-- name, an owner, a key or a record (the Phase 63 pattern).
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
GRANT SELECT ("tenant_id", "due_at") ON attachments TO horizon_relay;
CREATE POLICY relay_scan ON attachments FOR SELECT TO horizon_relay USING (true);
--> statement-breakpoint
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER attachment_removals_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON attachment_removals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
--> statement-breakpoint
-- An erased key is never restored: shredding is final (ADR 0026).
CREATE FUNCTION reject_key_restore() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.wrapped_key IS NULL AND NEW.wrapped_key IS NOT NULL THEN RAISE EXCEPTION 'an erased owner key cannot be restored'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_keys_stay_erased BEFORE UPDATE ON owner_keys
  FOR EACH ROW EXECUTE FUNCTION reject_key_restore();
--> statement-breakpoint
-- A deleted attachment never comes back. Its record and owner never change: the
-- application role cannot update those columns.
CREATE FUNCTION reject_attachment_revival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN RAISE EXCEPTION 'a deleted attachment cannot come back'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_stay_deleted BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION reject_attachment_revival();
--> statement-breakpoint
CREATE FUNCTION stamp_files_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_files_outbox_tenant();
