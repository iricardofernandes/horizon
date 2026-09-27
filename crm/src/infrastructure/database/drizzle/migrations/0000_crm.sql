CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A party holding a CRM role (ADR 0057). The registry's facts are refreshed by events;
-- owner, segment and tags are CRM's own. Names are blanked when the party is erased.
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text CHECK ("kind" IN ('organization', 'person')),
  "legal_name" text,
  "trade_name" text,
  "roles" text[] NOT NULL,
  "document_type" text CHECK ("document_type" IN ('cpf', 'cnpj', 'foreign', 'none')),
  "document_country" text CHECK ("document_country" ~ '^[A-Z]{2}$'),
  "party_active" boolean NOT NULL,
  "owner_id" uuid,
  "segment" text CHECK (char_length("segment") BETWEEN 1 AND 80),
  "tags" text[] NOT NULL CHECK (cardinality("tags") <= 20),
  "status" text NOT NULL CHECK ("status" IN ('active', 'inactive', 'erased')),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "accounts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "accounts_erased_names" CHECK ("status" <> 'erased' OR ("legal_name" = '' AND "trade_name" IS NULL)),
  CONSTRAINT "accounts_live_name" CHECK ("status" = 'erased' OR char_length("legal_name") >= 2)
);
--> statement-breakpoint
CREATE INDEX "accounts_tenant_status_idx" ON "accounts" ("tenant_id", "status", "legal_name");
CREATE INDEX "accounts_tenant_owner_idx" ON "accounts" ("tenant_id", "owner_id") WHERE "owner_id" IS NOT NULL;
--> statement-breakpoint
-- One key per contact. Destroying `material` is the erasure (ADR 0026).
CREATE TABLE "contact_data_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "material" text,
  "erased_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "contact_data_keys_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "contact_data_keys_erasure" CHECK (("material" IS NULL) = ("erased_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "name_ciphertext" text NOT NULL,
  "job_title_ciphertext" text,
  "email_ciphertext" text,
  "phone_ciphertext" text,
  "lawful_basis" text NOT NULL CHECK ("lawful_basis" IN ('contract', 'legitimate-interest', 'consent')),
  "status" text NOT NULL CHECK ("status" IN ('active', 'inactive', 'erased')),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "contacts_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id"),
  CONSTRAINT "contacts_data_key_fk" FOREIGN KEY ("tenant_id", "id") REFERENCES "contact_data_keys"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "contacts_tenant_account_idx" ON "contacts" ("tenant_id", "account_id", "created_at");
--> statement-breakpoint
CREATE TABLE "owners" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL,
  "active" boolean NOT NULL,
  "registered_at" timestamp with time zone NOT NULL,
  "disabled_at" timestamp with time zone,
  PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "owners_disabled" CHECK ("active" = ("disabled_at" IS NULL))
);
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
CREATE INDEX "audit_log_tenant_subject_idx" ON "audit_log" ("tenant_id", "subject_type", "subject_id", "sequence");
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
  FOREACH table_name IN ARRAY ARRAY['accounts','contact_data_keys','contacts','owners','command_receipts','audit_log','outbox','inbox'] LOOP
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
REVOKE ALL ON tenants, accounts, contact_data_keys, contacts, owners, command_receipts, audit_log, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
GRANT SELECT, INSERT ON accounts TO horizon_app;
GRANT UPDATE ("kind", "legal_name", "trade_name", "roles", "document_type", "document_country", "party_active", "owner_id", "segment", "tags", "status", "updated_at") ON accounts TO horizon_app;
GRANT SELECT, INSERT ON contact_data_keys TO horizon_app;
GRANT UPDATE ("material", "erased_at") ON contact_data_keys TO horizon_app;
GRANT SELECT, INSERT ON contacts TO horizon_app;
GRANT UPDATE ("name_ciphertext", "job_title_ciphertext", "email_ciphertext", "phone_ciphertext", "lawful_basis", "status", "updated_at") ON contacts TO horizon_app;
GRANT SELECT, INSERT ON owners TO horizon_app;
GRANT UPDATE ("active", "disabled_at") ON owners TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, INSERT ON inbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
-- An erased key is never restored: shredding is final (ADR 0026).
CREATE FUNCTION reject_key_restore() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.material IS NULL AND NEW.material IS NOT NULL THEN RAISE EXCEPTION 'an erased contact key cannot be restored'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_keys_stay_erased BEFORE UPDATE ON contact_data_keys
  FOR EACH ROW EXECUTE FUNCTION reject_key_restore();
--> statement-breakpoint
CREATE FUNCTION stamp_crm_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_crm_outbox_tenant();
