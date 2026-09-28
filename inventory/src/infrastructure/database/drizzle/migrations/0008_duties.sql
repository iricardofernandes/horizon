-- Segregation of duties and delegation (ADR 0062, Phase 68).
ALTER TABLE "stock_adjustments" ADD COLUMN "decided_for" text;
ALTER TABLE "stock_counts" ADD COLUMN "decided_for" text;
--> statement-breakpoint
-- Nobody who asked for an adjustment, or closed a count, decides it through a delegation
-- they lent.
ALTER TABLE "stock_adjustments"
  ADD CONSTRAINT "stock_adjustments_delegated_four_eyes_check" CHECK (
    "decided_for" IS NULL OR ("decided_for" <> "requested_by" AND "decided_for" <> "decided_by")
  );
ALTER TABLE "stock_counts"
  ADD CONSTRAINT "stock_counts_delegated_four_eyes_check" CHECK (
    "decided_for" IS NULL
    OR ("decided_for" IS DISTINCT FROM "closed_by" AND "decided_for" <> "decided_by")
  );
--> statement-breakpoint
GRANT UPDATE ("decided_for") ON stock_adjustments TO horizon_app;
GRANT UPDATE ("decided_for") ON stock_counts TO horizon_app;
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "permission" text NOT NULL CHECK ("permission" ~ '^inventory:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$'),
  "delegator_id" text NOT NULL,
  "delegate_id" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "reason" text CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  "created_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  CONSTRAINT "approval_delegations_people_check" CHECK ("delegator_id" <> "delegate_id"),
  CONSTRAINT "approval_delegations_period_check" CHECK (
    "ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '90 days'
  ),
  CONSTRAINT "approval_delegations_revocation_check" CHECK (
    ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "approval_delegations_delegate_idx"
  ON "approval_delegations" ("tenant_id", "delegate_id", "permission");
--> statement-breakpoint
ALTER TABLE "approval_delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_delegations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "approval_delegations" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON "approval_delegations" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "approval_delegations" TO horizon_app;
-- A delegation is only ever ended early; its terms are never rewritten.
GRANT UPDATE ("revoked_at", "revoked_by") ON "approval_delegations" TO horizon_app;
