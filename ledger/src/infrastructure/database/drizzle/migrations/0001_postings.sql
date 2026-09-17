-- A transaction may now account for a fact another module reported, and then it names
-- that fact: the settlement id, the transfer id, never the event id.
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_source_type_check";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_type_check" CHECK (
  "source_type" IN ('manual', 'receivable', 'payable', 'settlement', 'transfer', 'treasury-entry')
);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_id_check" CHECK (
  ("source_type" = 'manual') = ("source_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "account_mappings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "role" text NOT NULL CHECK ("role" IN (
    'receivables', 'payables', 'cash', 'revenue', 'expense', 'discount-granted',
    'discount-received', 'financial-income', 'financial-expense', 'bank-fees',
    'opening-balance', 'suspense'
  )),
  -- The treasury account or financial category this mapping is for. A role chosen once for
  -- the whole workspace stores the empty string, so the unique key below covers both cases
  -- without a partial index and without NULL comparing unequal to itself.
  "key" text NOT NULL DEFAULT '',
  "account_id" uuid NOT NULL,
  "account_code" text NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "account_mappings_tenant_role_key" UNIQUE ("tenant_id", "role", "key"),
  CONSTRAINT "account_mappings_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts" ("tenant_id", "id")
);
--> statement-breakpoint
-- Only these three roles are chosen per record; the rest are one account for the workspace.
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_keyed_check" CHECK (
  "key" = '' OR "role" IN ('cash', 'revenue', 'expense')
);
--> statement-breakpoint
CREATE TABLE "posting_facts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('receivable', 'payable', 'settlement', 'transfer', 'treasury-entry')),
  "fact_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('posted', 'pending', 'reversed', 'ignored')),
  "transaction_id" uuid,
  "reference" text NOT NULL,
  "reason" text,
  -- The numbers the fact arrived with, kept so a fact the workspace could not post yet can
  -- be replayed from here rather than from a redelivery nobody can ask for.
  "fact" jsonb NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "kind", "fact_id"),
  CONSTRAINT "posting_facts_transaction_fk" FOREIGN KEY ("tenant_id", "transaction_id") REFERENCES "transactions" ("tenant_id", "id"),
  CONSTRAINT "posting_facts_posted_check" CHECK (
    ("status" IN ('posted', 'reversed')) = ("transaction_id" IS NOT NULL)
  )
);
--> statement-breakpoint
-- One business fact posts at most one transaction, whatever a redelivery claims.
CREATE UNIQUE INDEX "posting_facts_transaction_key" ON "posting_facts" ("tenant_id", "transaction_id") WHERE "transaction_id" IS NOT NULL;
CREATE INDEX "posting_facts_pending_idx" ON "posting_facts" ("tenant_id", "received_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_module", "event_id")
);
--> statement-breakpoint
CREATE INDEX "inbox_received_idx" ON "inbox" ("received_at");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['account_mappings','posting_facts','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON account_mappings, posting_facts, inbox FROM horizon_app, horizon_relay;
-- A mapping is repointed at another account; what it already caused to be posted is
-- immutable, so repointing never rewrites history.
GRANT SELECT, INSERT ON account_mappings TO horizon_app;
GRANT UPDATE ("account_id", "account_code", "updated_by", "updated_at") ON account_mappings TO horizon_app;
-- A fact moves between pending, posted, reversed and ignored; its numbers never change.
GRANT SELECT, INSERT ON posting_facts TO horizon_app;
GRANT UPDATE ("status", "transaction_id", "reason", "updated_at") ON posting_facts TO horizon_app;
GRANT SELECT, INSERT ON inbox TO horizon_app;
--> statement-breakpoint
-- A posted fact keeps the transaction it posted: repointing it at another one would leave
-- the first orphaned in the journal and the books double-counted.
CREATE FUNCTION reject_fact_reposting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'fact % already posted transaction %', OLD.fact_id, OLD.transaction_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posting_facts_single_transaction BEFORE UPDATE ON posting_facts
  FOR EACH ROW EXECUTE FUNCTION reject_fact_reposting();
