-- A manual entry waits for a second person above a threshold, and delegation (ADR 0062,
-- Phase 68).
CREATE TABLE "entry_approval_policies" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "threshold" bigint NOT NULL CHECK ("threshold" >= 0),
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "currency")
);
--> statement-breakpoint
CREATE TABLE "manual_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "reference" text NOT NULL,
  "posted_on" date NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "memo" text,
  "lines" jsonb NOT NULL CHECK (jsonb_typeof("lines") = 'array'),
  "total" bigint NOT NULL CHECK ("total" > 0),
  "status" text NOT NULL CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "requested_by" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "decided_by" text,
  "decided_for" text,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "transaction_id" uuid,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "manual_entries_decision_check" CHECK (
    ("status" = 'pending') = ("decided_by" IS NULL AND "decided_at" IS NULL)
  ),
  CONSTRAINT "manual_entries_posting_check" CHECK (
    ("status" = 'approved') = ("transaction_id" IS NOT NULL)
  ),
  CONSTRAINT "manual_entries_rejection_check" CHECK (
    "status" <> 'rejected' OR "decision_reason" IS NOT NULL
  ),
  -- Whoever wrote the entry never decides it, in person or through a delegation they lent.
  CONSTRAINT "manual_entries_four_eyes_check" CHECK (
    "decided_by" IS NULL OR "decided_by" <> "requested_by"
  ),
  CONSTRAINT "manual_entries_delegated_four_eyes_check" CHECK (
    "decided_for" IS NULL OR ("decided_for" <> "requested_by" AND "decided_for" <> "decided_by")
  )
);
--> statement-breakpoint
CREATE INDEX "manual_entries_status_idx" ON "manual_entries" ("tenant_id", "status", "requested_at" DESC);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['entry_approval_policies','manual_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON entry_approval_policies, manual_entries FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON entry_approval_policies TO horizon_app;
GRANT SELECT, INSERT ON manual_entries TO horizon_app;
-- What was written is never rewritten; only the decision is recorded.
GRANT UPDATE ("status", "decided_by", "decided_for", "decided_at", "decision_reason",
  "transaction_id", "updated_at") ON manual_entries TO horizon_app;
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "permission" text NOT NULL CHECK ("permission" ~ '^ledger:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$'),
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
