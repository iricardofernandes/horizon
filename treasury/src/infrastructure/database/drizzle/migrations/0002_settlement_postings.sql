ALTER TABLE "journal_entries" ADD COLUMN "settlement_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check"
  CHECK ("source" IN ('opening', 'manual', 'transfer', 'transfer-fee', 'reversal', 'settlement'));
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_settlement_source_check"
  CHECK (("source" = 'settlement') <= ("settlement_id" IS NOT NULL));
--> statement-breakpoint
-- A settlement is recorded in the journal at most once, however often its event arrives.
CREATE UNIQUE INDEX "journal_entries_single_settlement_key" ON "journal_entries" ("tenant_id", "settlement_id") WHERE "source" = 'settlement';
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_source_event_key" UNIQUE ("source_module", "event_id")
);
--> statement-breakpoint
-- What happened to each settlement Financial reported with an account: recorded as an entry,
-- or refused with the reason (an inactive account, another currency), so nothing is lost
-- silently and an operator can see why a bank line has no entry to match.
CREATE TABLE "settlement_postings" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "settlement_id" uuid NOT NULL,
  "title_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('posted', 'refused')),
  "entry_id" uuid,
  "reason" text,
  "received_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "settlement_id"),
  CONSTRAINT "settlement_postings_outcome_check" CHECK (
    ("status" = 'posted') = ("entry_id" IS NOT NULL) AND ("status" = 'refused') = ("reason" IS NOT NULL)
  )
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['inbox','settlement_postings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON inbox, settlement_postings FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON inbox, settlement_postings TO horizon_app;
