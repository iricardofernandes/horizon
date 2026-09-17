ALTER TABLE "titles"
  ADD COLUMN "approval_state" text NOT NULL DEFAULT 'none'
    CHECK ("approval_state" IN ('none', 'pending', 'approved', 'rejected', 'not-required')),
  ADD COLUMN "approval_requested_by" text,
  ADD COLUMN "approval_requested_at" timestamp with time zone,
  ADD COLUMN "approval_decided_by" text,
  ADD COLUMN "approval_decided_at" timestamp with time zone,
  ADD COLUMN "approval_reason" text;
--> statement-breakpoint
-- Receivables posted before approvals existed never needed one. The owner is subject to
-- forced RLS like everyone else, so the backfill lifts it for this statement only: without
-- that the update sees no tenant's rows, while the constraint below validates all of them.
ALTER TABLE "titles" NO FORCE ROW LEVEL SECURITY;
UPDATE "titles" SET "approval_state" = 'not-required' WHERE "status" IN ('posted', 'reversed');
ALTER TABLE "titles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A payable can only have been posted once approved or exempted by policy, and the person
-- who approved it is never the person who asked (four eyes), whatever the application does.
ALTER TABLE "titles"
  ADD CONSTRAINT "titles_posted_approval_check" CHECK (
    "status" IN ('draft', 'cancelled') OR "approval_state" IN ('approved', 'not-required')
  ),
  ADD CONSTRAINT "titles_four_eyes_check" CHECK (
    "approval_decided_by" IS NULL OR "approval_decided_by" <> "approval_requested_by"
  ),
  ADD CONSTRAINT "titles_approval_direction_check" CHECK (
    "direction" = 'payable' OR "approval_state" IN ('none', 'not-required')
  );
--> statement-breakpoint
CREATE INDEX "titles_tenant_approval_idx" ON "titles" ("tenant_id", "direction", "approval_state") WHERE "status" = 'draft';
--> statement-breakpoint
CREATE TABLE "approval_policies" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "direction" text NOT NULL CHECK ("direction" IN ('payable')),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "threshold" bigint NOT NULL CHECK ("threshold" >= 0),
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "direction", "currency")
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "approval_policies" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON "approval_policies" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON "approval_policies" TO horizon_app;
