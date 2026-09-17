CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "code" text NOT NULL CHECK ("code" ~ '^\d{1,3}(\.\d{1,3}){0,4}$'),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 2 AND 120),
  "type" text NOT NULL CHECK ("type" IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  "parent_id" uuid,
  "postable" boolean NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "accounts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "accounts_tenant_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "accounts_parent_fk" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "accounts" ("tenant_id", "id"),
  -- A top-level code has one group and no parent; every deeper code has both.
  CONSTRAINT "accounts_root_check" CHECK (("code" LIKE '%.%') = ("parent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "periods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "period" text NOT NULL CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  "status" text NOT NULL CHECK ("status" IN ('open', 'closed')),
  "closed_by" text NOT NULL,
  "closed_at" timestamp with time zone NOT NULL,
  "reopened_by" text,
  "reopened_at" timestamp with time zone,
  "reopen_reason" text,
  CONSTRAINT "periods_tenant_period_key" UNIQUE ("tenant_id", "period"),
  CONSTRAINT "periods_reopen_check" CHECK (
    ("status" = 'open') = ("reopened_by" IS NOT NULL AND "reopened_at" IS NOT NULL AND "reopen_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "transactions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "reference" text NOT NULL CHECK (char_length("reference") BETWEEN 1 AND 60),
  "posted_on" date NOT NULL,
  "period" text NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "total" bigint NOT NULL CHECK ("total" > 0),
  "source_type" text NOT NULL CHECK ("source_type" IN ('manual')),
  "source_id" uuid,
  "memo" text,
  "status" text NOT NULL CHECK ("status" IN ('posted', 'reversed')),
  "reverses" uuid,
  "reversed_by" uuid,
  "reversal_reason" text,
  "posted_at" timestamp with time zone NOT NULL,
  "reversed_at" timestamp with time zone,
  CONSTRAINT "transactions_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "transactions_reverses_fk" FOREIGN KEY ("tenant_id", "reverses") REFERENCES "transactions" ("tenant_id", "id"),
  -- The period is the month of the posting date, and cannot be set to anything else.
  CONSTRAINT "transactions_period_check" CHECK ("period" = to_char("posted_on", 'YYYY-MM')),
  CONSTRAINT "transactions_reversal_check" CHECK (
    ("status" = 'reversed') = ("reversed_by" IS NOT NULL AND "reversal_reason" IS NOT NULL AND "reversed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
-- A transaction is undone once, by one mirror.
CREATE UNIQUE INDEX "transactions_single_reversal_key" ON "transactions" ("tenant_id", "reverses") WHERE "reverses" IS NOT NULL;
CREATE INDEX "transactions_period_idx" ON "transactions" ("tenant_id", "period", "posted_on", "id");
--> statement-breakpoint
CREATE TABLE "transaction_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "transaction_id" uuid NOT NULL,
  "line_number" integer NOT NULL CHECK ("line_number" > 0),
  "account_id" uuid NOT NULL,
  "account_code" text NOT NULL,
  "side" text NOT NULL CHECK ("side" IN ('debit', 'credit')),
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- Copied from the transaction so every balance query reads one table (the check below
  -- keeps the copy honest).
  "posted_on" date NOT NULL,
  "period" text NOT NULL,
  "memo" text,
  PRIMARY KEY ("tenant_id", "transaction_id", "line_number"),
  CONSTRAINT "transaction_lines_transaction_fk" FOREIGN KEY ("tenant_id", "transaction_id") REFERENCES "transactions" ("tenant_id", "id"),
  CONSTRAINT "transaction_lines_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "transaction_lines_period_check" CHECK ("period" = to_char("posted_on", 'YYYY-MM'))
);
--> statement-breakpoint
CREATE INDEX "transaction_lines_account_idx" ON "transaction_lines" ("tenant_id", "account_id", "posted_on", "transaction_id", "line_number");
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
  FOREACH table_name IN ARRAY ARRAY['accounts','periods','transactions','transaction_lines','command_receipts','audit_log','outbox'] LOOP
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
REVOKE ALL ON tenants, accounts, periods, transactions, transaction_lines, command_receipts, audit_log, outbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants TO horizon_app;
-- An account is renamed by nobody and deactivated by an admin; its code and place in the
-- tree are fixed, because every posting already made refers to them.
GRANT SELECT, INSERT ON accounts TO horizon_app;
GRANT UPDATE ("active", "updated_at") ON accounts TO horizon_app;
-- A month is closed and reopened; it is never deleted.
GRANT SELECT, INSERT ON periods TO horizon_app;
GRANT UPDATE ("status", "closed_by", "closed_at", "reopened_by", "reopened_at", "reopen_reason") ON periods TO horizon_app;
-- A posted transaction only ever changes by being marked reversed (ADR 0042).
GRANT SELECT, INSERT ON transactions TO horizon_app;
GRANT UPDATE ("status", "reversed_by", "reversal_reason", "reversed_at") ON transactions TO horizon_app;
-- Lines are append-only: there is no UPDATE grant at all.
GRANT SELECT, INSERT ON transaction_lines, audit_log TO horizon_app;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'transaction_lines is append-only'; END $$;
CREATE TRIGGER transaction_lines_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON transaction_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_journal_mutation();
--> statement-breakpoint
CREATE FUNCTION reject_transaction_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'transactions are reversed, never deleted'; END $$;
CREATE TRIGGER transactions_no_deletion BEFORE DELETE OR TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_transaction_deletion();
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
-- A parent account totals its children and takes no lines of its own. Checking it here as
-- well as in the domain means a future code path cannot quietly file a child under a
-- postable account and corrupt every total above it.
CREATE FUNCTION require_postable_leaf() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  SELECT code, type, currency, postable INTO parent FROM accounts
    WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
  IF parent.postable THEN
    RAISE EXCEPTION 'account % takes postings and cannot have children', parent.code;
  END IF;
  IF parent.type <> NEW.type OR parent.currency <> NEW.currency THEN
    RAISE EXCEPTION 'account % does not match its parent %', NEW.code, parent.code;
  END IF;
  IF NEW.code NOT LIKE parent.code || '.%'
     OR array_length(string_to_array(NEW.code, '.'), 1)
        <> array_length(string_to_array(parent.code, '.'), 1) + 1 THEN
    RAISE EXCEPTION 'account code % does not extend its parent %', NEW.code, parent.code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_postable_leaf BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION require_postable_leaf();
--> statement-breakpoint
-- Nothing enters a closed month, whatever the application believes.
CREATE FUNCTION reject_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM periods
    WHERE tenant_id = NEW.tenant_id AND period = NEW.period AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'period % is closed', NEW.period;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transactions_period_open BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_closed_period();
--> statement-breakpoint
-- The invariant the whole module exists for: a transaction committed with debits and
-- credits that disagree, or with fewer than two lines, is refused at commit time even if
-- some future code path writes it directly.
CREATE FUNCTION require_balanced_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debits bigint; credits bigint; lines integer;
BEGIN
  SELECT
    coalesce(sum(amount) FILTER (WHERE side = 'debit'), 0),
    coalesce(sum(amount) FILTER (WHERE side = 'credit'), 0),
    count(*)
  INTO debits, credits, lines
  FROM transaction_lines
  WHERE tenant_id = NEW.tenant_id AND transaction_id = NEW.id;
  IF lines < 2 THEN
    RAISE EXCEPTION 'transaction % must have at least a debit and a credit', NEW.id;
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'transaction % does not balance: % debit against % credit', NEW.id, debits, credits;
  END IF;
  IF debits <> NEW.total THEN
    RAISE EXCEPTION 'transaction % totals % but its lines add up to %', NEW.id, NEW.total, debits;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transactions_require_balance AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_balanced_transaction();
--> statement-breakpoint
CREATE FUNCTION stamp_ledger_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_ledger_outbox_tenant();
