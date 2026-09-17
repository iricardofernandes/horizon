-- Reconciliation state is derived from reconciliations, never stored on a journal line.
ALTER TABLE "journal_entries" DROP COLUMN "reconciliation_state";
--> statement-breakpoint
CREATE TABLE "statement_imports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "format" text NOT NULL CHECK ("format" IN ('ofx', 'csv')),
  "file_name" text NOT NULL CHECK (char_length("file_name") BETWEEN 1 AND 255),
  "file_hash" text NOT NULL CHECK ("file_hash" ~ '^[0-9a-f]{64}$'),
  "line_count" integer NOT NULL CHECK ("line_count" >= 0),
  "duplicate_count" integer NOT NULL CHECK ("duplicate_count" >= 0),
  "period_start" date,
  "period_end" date,
  "closing_balance" bigint,
  "closing_balance_on" date,
  "imported_by" text NOT NULL,
  "imported_at" timestamp with time zone NOT NULL,
  CONSTRAINT "statement_imports_tenant_id_key" UNIQUE ("tenant_id", "id"),
  -- The same file imported twice into the same account is one import.
  CONSTRAINT "statement_imports_file_key" UNIQUE ("tenant_id", "account_id", "file_hash"),
  CONSTRAINT "statement_imports_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "statement_imports_balance_check" CHECK (("closing_balance" IS NULL) = ("closing_balance_on" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "statement_lines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "import_id" uuid NOT NULL,
  "fingerprint" text NOT NULL CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  "posted_on" date NOT NULL,
  "amount" bigint NOT NULL CHECK ("amount" <> 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "bank_reference" text,
  "document_id" text,
  "description" text NOT NULL,
  "counterparty" text,
  "raw" jsonb NOT NULL CHECK (jsonb_typeof("raw") = 'object'),
  CONSTRAINT "statement_lines_tenant_id_key" UNIQUE ("tenant_id", "id"),
  -- A line the bank already told us about is never stored twice.
  CONSTRAINT "statement_lines_fingerprint_key" UNIQUE ("tenant_id", "account_id", "fingerprint"),
  CONSTRAINT "statement_lines_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "statement_lines_import_fk" FOREIGN KEY ("tenant_id", "import_id") REFERENCES "statement_imports" ("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "statement_lines_account_date_idx" ON "statement_lines" ("tenant_id", "account_id", "posted_on", "id");
--> statement-breakpoint
CREATE TABLE "reconciliations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('match', 'ignore')),
  "origin" text NOT NULL CHECK ("origin" IN ('manual', 'suggestion')),
  "suggestion_key" text,
  "suggestion_score" smallint CHECK ("suggestion_score" IS NULL OR "suggestion_score" BETWEEN 0 AND 100),
  "corrected" boolean NOT NULL DEFAULT false,
  "reason" text,
  "status" text NOT NULL CHECK ("status" IN ('active', 'undone')),
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "undone_by" text,
  "undone_at" timestamp with time zone,
  "undo_reason" text,
  CONSTRAINT "reconciliations_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "reconciliations_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "reconciliations_suggestion_origin_check" CHECK (("origin" = 'suggestion') = ("suggestion_key" IS NOT NULL)),
  CONSTRAINT "reconciliations_ignore_reason_check" CHECK (("kind" = 'ignore') = ("reason" IS NOT NULL)),
  CONSTRAINT "reconciliations_undo_check" CHECK (
    ("status" = 'undone') = ("undone_by" IS NOT NULL AND "undone_at" IS NOT NULL AND "undo_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "reconciliation_items" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "reconciliation_id" uuid NOT NULL,
  "statement_line_id" uuid,
  "entry_id" uuid,
  "applied" bigint NOT NULL CHECK ("applied" <> 0),
  CONSTRAINT "reconciliation_items_reconciliation_fk" FOREIGN KEY ("tenant_id", "reconciliation_id") REFERENCES "reconciliations" ("tenant_id", "id"),
  CONSTRAINT "reconciliation_items_line_fk" FOREIGN KEY ("tenant_id", "statement_line_id") REFERENCES "statement_lines" ("tenant_id", "id"),
  CONSTRAINT "reconciliation_items_entry_fk" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "journal_entries" ("tenant_id", "id"),
  CONSTRAINT "reconciliation_items_one_side_check" CHECK (("statement_line_id" IS NULL) <> ("entry_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "reconciliation_items_line_idx" ON "reconciliation_items" ("tenant_id", "statement_line_id") WHERE "statement_line_id" IS NOT NULL;
CREATE INDEX "reconciliation_items_entry_idx" ON "reconciliation_items" ("tenant_id", "entry_id") WHERE "entry_id" IS NOT NULL;
CREATE INDEX "reconciliation_items_group_idx" ON "reconciliation_items" ("tenant_id", "reconciliation_id");
--> statement-breakpoint
CREATE TABLE "dismissed_suggestions" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "suggestion_key" text NOT NULL,
  "score" smallint NOT NULL CHECK ("score" BETWEEN 0 AND 100),
  "dismissed_by" text NOT NULL,
  "dismissed_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "account_id", "suggestion_key"),
  CONSTRAINT "dismissed_suggestions_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_closures" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "account_id" uuid NOT NULL,
  "through" date NOT NULL,
  "closed_by" text NOT NULL,
  "closed_at" timestamp with time zone NOT NULL,
  "reopened_by" text,
  "reopened_at" timestamp with time zone,
  "reopen_reason" text,
  CONSTRAINT "reconciliation_closures_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id"),
  CONSTRAINT "reconciliation_closures_reopen_check" CHECK (
    ("reopened_at" IS NULL) = ("reopened_by" IS NULL AND "reopen_reason" IS NULL)
  )
);
--> statement-breakpoint
-- At most one period closure in force per account.
CREATE UNIQUE INDEX "reconciliation_closures_in_force_key" ON "reconciliation_closures" ("tenant_id", "account_id") WHERE "reopened_at" IS NULL;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['statement_imports','statement_lines','reconciliations','reconciliation_items','dismissed_suggestions','reconciliation_closures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON statement_imports, statement_lines, reconciliations, reconciliation_items, dismissed_suggestions, reconciliation_closures FROM horizon_app, horizon_relay;
-- What the bank said is never edited or deleted (ADR 0046).
GRANT SELECT, INSERT ON statement_imports, statement_lines, reconciliation_items, dismissed_suggestions TO horizon_app;
GRANT SELECT, INSERT ON reconciliations, reconciliation_closures TO horizon_app;
GRANT UPDATE ("status", "undone_by", "undone_at", "undo_reason") ON reconciliations TO horizon_app;
GRANT UPDATE ("reopened_by", "reopened_at", "reopen_reason") ON reconciliation_closures TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_statement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER statement_lines_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON statement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_mutation();
CREATE TRIGGER statement_imports_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON statement_imports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_mutation();
CREATE TRIGGER reconciliation_items_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON reconciliation_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_mutation();
--> statement-breakpoint
-- A reconciliation in force balances: its bank lines and entries add up to the same amount.
CREATE FUNCTION require_balanced_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; lines bigint; entries bigint;
BEGIN
  SELECT r.kind INTO kind FROM reconciliations r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.id;
  SELECT coalesce(sum(applied) FILTER (WHERE statement_line_id IS NOT NULL), 0),
         coalesce(sum(applied) FILTER (WHERE entry_id IS NOT NULL), 0)
    INTO lines, entries
    FROM reconciliation_items WHERE tenant_id = NEW.tenant_id AND reconciliation_id = NEW.id;
  IF lines = 0 OR (kind = 'match' AND lines <> entries) OR (kind = 'ignore' AND entries <> 0) THEN
    RAISE EXCEPTION 'reconciliation % does not balance', NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliations_balance AFTER INSERT ON reconciliations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_balanced_reconciliation();
