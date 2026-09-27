-- Phase 58: Sales quotes made for an opportunity, followed from sales.quote.* events, and
-- the conversion an accepted quote records. CRM never writes to Sales; it only listens.
ALTER TABLE "opportunities" ADD COLUMN "converted_quote_id" uuid;
ALTER TABLE "opportunities" ADD COLUMN "converted_quote_root" uuid;
ALTER TABLE "opportunities" ADD COLUMN "converted_quote_version" integer CHECK ("converted_quote_version" > 0);
-- A conversion is complete or absent, and only a won opportunity has one.
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_conversion" CHECK (
  ("converted_quote_id" IS NULL) = ("converted_quote_root" IS NULL)
  AND ("converted_quote_id" IS NULL) = ("converted_quote_version" IS NULL)
  AND ("converted_quote_id" IS NULL OR "status" = 'won')
);
GRANT UPDATE ("converted_quote_id", "converted_quote_root", "converted_quote_version") ON opportunities TO horizon_app;
--> statement-breakpoint
ALTER TABLE "opportunity_events" DROP CONSTRAINT "opportunity_events_type_check";
ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_type_check"
  CHECK ("type" IN ('created', 'revised', 'stage-changed', 'owner-changed', 'won', 'lost', 'reopened', 'converted'));
--> statement-breakpoint
-- One row per offer (every version of a quote shares its root): the latest version seen
-- and what happened to it. An older version or an earlier state never overwrites a newer one.
CREATE TABLE "opportunity_quotes" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "opportunity_id" uuid NOT NULL,
  "quote_root" uuid NOT NULL,
  "quote_id" uuid NOT NULL,
  "quote_version" integer NOT NULL CHECK ("quote_version" > 0),
  "status" text NOT NULL CHECK ("status" IN ('sent', 'accepted', 'rejected')),
  "total_amount" bigint CHECK ("total_amount" >= 0),
  "currency" text CHECK ("currency" ~ '^[A-Z]{3}$'),
  "seen_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "opportunity_id", "quote_root"),
  CONSTRAINT "opportunity_quotes_opportunity_fk" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunities"("tenant_id", "id"),
  CONSTRAINT "opportunity_quotes_total" CHECK (("total_amount" IS NULL) = ("currency" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "opportunity_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "opportunity_quotes" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON opportunity_quotes FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON opportunity_quotes TO horizon_app;
GRANT UPDATE ("quote_id", "quote_version", "status", "total_amount", "currency", "seen_at") ON opportunity_quotes TO horizon_app;
