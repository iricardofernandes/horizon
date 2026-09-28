-- Segregation of duties and delegation (ADR 0062, Phase 68).
ALTER TABLE "requisitions" ADD COLUMN "decided_for" text;
ALTER TABLE "orders" ADD COLUMN "approval_decided_for" text;
--> statement-breakpoint
-- Whatever the application does, nobody who requested, submitted or placed decides, in
-- person or through a delegation they lent. NOT VALID: older rows were decided under the
-- earlier, narrower rule, and are left as they were.
ALTER TABLE "requisitions"
  ADD CONSTRAINT "requisitions_four_eyes_check" CHECK (
    "decided_by" IS NULL
    OR ("decided_by" <> "requested_by" AND "decided_by" IS DISTINCT FROM "submitted_by")
  ) NOT VALID,
  ADD CONSTRAINT "requisitions_delegated_four_eyes_check" CHECK (
    "decided_for" IS NULL OR (
      "decided_for" <> "requested_by"
      AND "decided_for" IS DISTINCT FROM "submitted_by"
      AND "decided_for" <> "decided_by"
    )
  );
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delegated_four_eyes_check" CHECK (
    "approval_decided_for" IS NULL OR (
      "approval_decided_for" IS DISTINCT FROM "approval_requested_by"
      AND "approval_decided_for" <> "approval_decided_by"
    )
  );
--> statement-breakpoint
GRANT UPDATE ("decided_for") ON requisitions TO horizon_app;
GRANT UPDATE ("approval_decided_for") ON orders TO horizon_app;
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "permission" text NOT NULL CHECK ("permission" ~ '^procurement:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$'),
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
