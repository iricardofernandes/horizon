-- Phase 58: the CRM opportunities Sales knows about, from crm.opportunity.* events, and
-- the attribution a quote freezes from them. Sales never takes an owner or a source from a
-- request; it reads them here.
CREATE TABLE "opportunity_projections" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  -- Facts may arrive out of order: a field is unknown until a fact sets it, and keeps the
  -- instant of the fact that last set it, so an older fact never wins.
  "owner_id" uuid,
  "owner_as_of" timestamptz,
  "source_id" uuid,
  "source_as_of" timestamptz,
  "status" text CHECK ("status" IN ('open', 'won', 'lost')),
  "status_as_of" timestamptz,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "opportunity_projections_owner" CHECK (("owner_id" IS NULL) = ("owner_as_of" IS NULL)),
  CONSTRAINT "opportunity_projections_source" CHECK ("source_as_of" IS NOT NULL OR "source_id" IS NULL),
  CONSTRAINT "opportunity_projections_status" CHECK (("status" IS NULL) = ("status_as_of" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "opportunity_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_projections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "opportunity_projections" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON opportunity_projections FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON opportunity_projections TO horizon_app;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "opportunity_id" uuid;
ALTER TABLE "quotes" ADD COLUMN "attributed_owner_id" uuid;
ALTER TABLE "quotes" ADD COLUMN "attributed_source_id" uuid;
-- An attributed quote names its opportunity and the owner it froze; the source may be absent.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_attribution" CHECK (
  ("opportunity_id" IS NULL) = ("attributed_owner_id" IS NULL)
  AND ("opportunity_id" IS NOT NULL OR "attributed_source_id" IS NULL)
);
CREATE INDEX "quotes_tenant_opportunity_idx" ON "quotes" ("tenant_id", "opportunity_id") WHERE "opportunity_id" IS NOT NULL;
