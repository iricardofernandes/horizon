-- Sales predates the audit log and the command receipts every later module keeps. Both
-- arrive here, because a quote that can be negotiated is a document whose history matters.
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
-- A quote is negotiated in versions. Every version of one offer shares the first one's
-- identifier, which is what makes them one offer rather than several unrelated ones.
ALTER TABLE "quotes" ADD COLUMN "root_id" uuid;
-- The owner is subject to forced RLS like everyone else, so a backfill lifts it for the
-- statement that needs it: without that the update sees no tenant's rows, while the
-- NOT NULL below is validated against all of them.
ALTER TABLE "quotes" NO FORCE ROW LEVEL SECURITY;
UPDATE "quotes" SET "root_id" = "id" WHERE "root_id" IS NULL;
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "quotes" ALTER COLUMN "root_id" SET NOT NULL;
ALTER TABLE "quotes" ADD COLUMN "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0);
ALTER TABLE "quotes" ALTER COLUMN "version" DROP DEFAULT;
ALTER TABLE "quotes" ADD COLUMN "supersedes" uuid;
ALTER TABLE "quotes" ADD COLUMN "superseded_by" uuid;
ALTER TABLE "quotes" ADD COLUMN "order_id" uuid;
ALTER TABLE "quotes" ADD COLUMN "sent_at" timestamptz;
ALTER TABLE "quotes" ADD COLUMN "closure_reason" text;
--> statement-breakpoint
-- What the offer says beyond the goods themselves.
ALTER TABLE "quotes" ADD COLUMN "seller_id" uuid;
ALTER TABLE "quotes" ADD COLUMN "discount" bigint NOT NULL DEFAULT 0 CHECK ("discount" >= 0);
ALTER TABLE "quotes" ALTER COLUMN "discount" DROP DEFAULT;
ALTER TABLE "quotes" ADD COLUMN "freight" bigint NOT NULL DEFAULT 0 CHECK ("freight" >= 0);
ALTER TABLE "quotes" ALTER COLUMN "freight" DROP DEFAULT;
ALTER TABLE "quotes" ADD COLUMN "carrier" text;
ALTER TABLE "quotes" ADD COLUMN "payment_term_days" jsonb NOT NULL DEFAULT '[0]'::jsonb;
ALTER TABLE "quotes" ALTER COLUMN "payment_term_days" DROP DEFAULT;
ALTER TABLE "quotes" ADD COLUMN "notes" text;
ALTER TABLE "quotes" ADD COLUMN "net" bigint NOT NULL DEFAULT 0 CHECK ("net" >= 0);
ALTER TABLE "quotes" NO FORCE ROW LEVEL SECURITY;
-- An offer written before freight and discounts existed charged exactly its goods.
UPDATE "quotes" SET "net" = "total";
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "quotes" ALTER COLUMN "net" DROP DEFAULT;
--> statement-breakpoint
-- A discount deep enough to matter waits for somebody else.
ALTER TABLE "quotes" ADD COLUMN "approval_state" text NOT NULL DEFAULT 'none'
  CHECK ("approval_state" IN ('none', 'pending', 'approved', 'rejected', 'not-required'));
ALTER TABLE "quotes" ALTER COLUMN "approval_state" DROP DEFAULT;
ALTER TABLE "quotes" ADD COLUMN "approval_requested_by" text;
ALTER TABLE "quotes" ADD COLUMN "approval_requested_at" timestamptz;
ALTER TABLE "quotes" ADD COLUMN "approval_decided_by" text;
ALTER TABLE "quotes" ADD COLUMN "approval_decided_at" timestamptz;
ALTER TABLE "quotes" ADD COLUMN "approval_reason" text;
--> statement-breakpoint
ALTER TABLE "quotes" DROP CONSTRAINT "quotes_status_check";
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_status_check" CHECK (
  "status" IN ('draft', 'pending', 'sent', 'accepted', 'rejected', 'expired', 'superseded')
);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_supersedes_fk"
  FOREIGN KEY ("tenant_id", "supersedes") REFERENCES "quotes" ("tenant_id", "id");
-- Four eyes: an approval nobody asked for is not an approval.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_four_eyes_check" CHECK (
  "approval_state" <> 'approved'
  OR "approval_requested_by" IS NULL
  OR "approval_decided_by" <> "approval_requested_by"
);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rejection_check" CHECK (
  "status" <> 'rejected' OR "closure_reason" IS NOT NULL
);
--> statement-breakpoint
-- Exactly one version of an offer is current at any moment.
CREATE UNIQUE INDEX "quotes_single_current_key" ON "quotes" ("tenant_id", "root_id")
  WHERE "status" IN ('draft', 'pending', 'sent', 'accepted');
CREATE INDEX "quotes_root_idx" ON "quotes" ("tenant_id", "root_id", "version");
--> statement-breakpoint
-- The order carries what was agreed, copied from the quote it came from.
ALTER TABLE "sales_orders" ADD COLUMN "quote_id" uuid;
ALTER TABLE "sales_orders" ADD COLUMN "seller_id" uuid;
ALTER TABLE "sales_orders" ADD COLUMN "discount" bigint NOT NULL DEFAULT 0 CHECK ("discount" >= 0);
ALTER TABLE "sales_orders" ALTER COLUMN "discount" DROP DEFAULT;
ALTER TABLE "sales_orders" ADD COLUMN "freight" bigint NOT NULL DEFAULT 0 CHECK ("freight" >= 0);
ALTER TABLE "sales_orders" ALTER COLUMN "freight" DROP DEFAULT;
ALTER TABLE "sales_orders" ADD COLUMN "carrier" text;
ALTER TABLE "sales_orders" ADD COLUMN "payment_term_days" jsonb NOT NULL DEFAULT '[0]'::jsonb;
ALTER TABLE "sales_orders" ALTER COLUMN "payment_term_days" DROP DEFAULT;
ALTER TABLE "sales_orders" ADD COLUMN "issued_on" date;
-- An order written before it had an issue date was issued the day it was written.
ALTER TABLE "sales_orders" NO FORCE ROW LEVEL SECURITY;
UPDATE "sales_orders" SET "issued_on" = "created_at"::date WHERE "issued_on" IS NULL;
ALTER TABLE "sales_orders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sales_orders" ALTER COLUMN "issued_on" SET NOT NULL;
ALTER TABLE "sales_orders" ADD COLUMN "notes" text;
-- An order has a currency from the moment it is drafted: its terms carry money before its
-- lines are priced. A total still cannot exist without one.
ALTER TABLE "sales_orders" DROP CONSTRAINT "sales_orders_total_currency_check";
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_total_currency_check"
  CHECK ("total" IS NULL OR "currency" IS NOT NULL);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_fk"
  FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quotes" ("tenant_id", "id");
-- An accepted quote becomes at most one order.
CREATE UNIQUE INDEX "sales_orders_single_quote_key" ON "sales_orders" ("tenant_id", "quote_id")
  WHERE "quote_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['command_receipts','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON command_receipts, audit_log FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT SELECT, INSERT ON audit_log TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
-- A sent quote is never rewritten: negotiating produces a new version beside it.
CREATE FUNCTION reject_sent_quote_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote_status text;
BEGIN
  SELECT status INTO quote_status FROM quotes
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF quote_status IS NOT NULL AND quote_status NOT IN ('draft', 'pending') THEN
    RAISE EXCEPTION 'quote lines cannot change once the offer has been sent';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER quote_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION reject_sent_quote_lines();
