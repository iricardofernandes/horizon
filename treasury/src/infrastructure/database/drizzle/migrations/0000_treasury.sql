CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('bank', 'cash', 'card-clearing', 'virtual')),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 2 AND 120),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "bank_code" text CHECK ("bank_code" IS NULL OR "bank_code" ~ '^\d{3}$'),
  "branch" text,
  "account_number" text,
  "opened_on" date NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "accounts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "accounts_tenant_name_key" UNIQUE ("tenant_id", "name"),
  CONSTRAINT "accounts_bank_details_check" CHECK (
    ("kind" = 'bank') OR ("bank_code" IS NULL AND "branch" IS NULL AND "account_number" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "transfers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "from_account_id" uuid NOT NULL,
  "to_account_id" uuid NOT NULL,
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "fee" bigint CHECK ("fee" IS NULL OR "fee" > 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "value_on" date NOT NULL,
  "memo" text,
  "status" text NOT NULL CHECK ("status" IN ('posted', 'cancelled')),
  "posted_at" timestamp with time zone NOT NULL,
  "cancelled_at" timestamp with time zone,
  "cancellation_reason" text,
  CONSTRAINT "transfers_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "transfers_from_fk" FOREIGN KEY ("tenant_id", "from_account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "transfers_to_fk" FOREIGN KEY ("tenant_id", "to_account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "transfers_distinct_accounts_check" CHECK ("from_account_id" <> "to_account_id"),
  CONSTRAINT "transfers_cancellation_check" CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "direction" text NOT NULL CHECK ("direction" IN ('inflow', 'outflow')),
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "value_on" date NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('opening', 'manual', 'transfer', 'transfer-fee', 'reversal')),
  "transfer_id" uuid,
  "reverses" uuid,
  "counterparty" text,
  "memo" text,
  "reason" text,
  -- Statement reconciliation arrives with bank statements (Phase E); until then nothing is.
  "reconciliation_state" text NOT NULL DEFAULT 'unreconciled'
    CHECK ("reconciliation_state" IN ('unreconciled', 'reconciled')),
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "journal_entries_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "journal_entries_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "journal_entries_transfer_fk" FOREIGN KEY ("tenant_id", "transfer_id") REFERENCES "transfers" ("tenant_id", "id"),
  CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("tenant_id", "reverses") REFERENCES "journal_entries" ("tenant_id", "id"),
  CONSTRAINT "journal_entries_transfer_source_check" CHECK (
    ("source" IN ('transfer', 'transfer-fee')) <= ("transfer_id" IS NOT NULL)
  ),
  CONSTRAINT "journal_entries_reversal_check" CHECK (
    ("source" = 'reversal') = ("reverses" IS NOT NULL AND "reason" IS NOT NULL)
  )
);
--> statement-breakpoint
-- An entry is reversed at most once, and an account has at most one opening balance.
CREATE UNIQUE INDEX "journal_entries_single_reversal_key" ON "journal_entries" ("tenant_id", "reverses") WHERE "reverses" IS NOT NULL;
CREATE UNIQUE INDEX "journal_entries_single_opening_key" ON "journal_entries" ("tenant_id", "account_id") WHERE "source" = 'opening';
CREATE INDEX "journal_entries_statement_idx" ON "journal_entries" ("tenant_id", "account_id", "value_on", "recorded_at", "id");
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
  "subject_id" uuid NOT NULL,
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
GRANT USAGE ON SCHEMA public TO horizon_relay;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['accounts','transfers','journal_entries','command_receipts','audit_log','outbox'] LOOP
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
REVOKE ALL ON tenants, accounts, transfers, journal_entries, command_receipts, audit_log, outbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
-- Accounts are deactivated, never deleted: the journal keeps pointing at them.
GRANT SELECT, INSERT ON accounts TO horizon_app;
GRANT UPDATE ("active", "updated_at") ON accounts TO horizon_app;
-- A transfer only ever changes by being cancelled.
GRANT SELECT, INSERT ON transfers TO horizon_app;
GRANT UPDATE ("status", "cancelled_at", "cancellation_reason") ON transfers TO horizon_app;
-- The journal is append-only for the application (ADR 0042).
GRANT SELECT, INSERT ON journal_entries, audit_log TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'journal_entries is append-only'; END $$;
CREATE TRIGGER journal_append_only BEFORE DELETE OR TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
-- A transfer committed without its outflow and inflow legs is refused at commit time, even
-- if some future code path forgets to write them.
CREATE FUNCTION require_transfer_legs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    SELECT count(*) FROM journal_entries
    WHERE tenant_id = NEW.tenant_id AND transfer_id = NEW.id AND source = 'transfer'
      AND ((direction = 'outflow' AND account_id = NEW.from_account_id)
        OR (direction = 'inflow' AND account_id = NEW.to_account_id))
  ) <> 2 THEN
    RAISE EXCEPTION 'transfer % must have exactly one outflow and one inflow leg', NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transfers_require_legs AFTER INSERT ON transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_transfer_legs();
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION stamp_treasury_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_treasury_outbox_tenant();
