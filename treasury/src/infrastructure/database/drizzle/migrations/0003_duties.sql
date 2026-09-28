-- A transfer waits for a second person above a threshold, and delegation (ADR 0062,
-- Phase 68).
ALTER TABLE "transfers"
  ADD COLUMN "requested_by" text,
  ADD COLUMN "requested_at" timestamp with time zone,
  ADD COLUMN "decided_by" text,
  ADD COLUMN "decided_for" text,
  ADD COLUMN "decided_at" timestamp with time zone,
  ADD COLUMN "decision_reason" text;
--> statement-breakpoint
-- Older transfers were asked for and posted in the same instant. The owner is subject to
-- forced RLS like everyone else, so the backfill lifts it for this statement only.
ALTER TABLE "transfers" NO FORCE ROW LEVEL SECURITY;
UPDATE "transfers" SET "requested_at" = "posted_at";
ALTER TABLE "transfers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "transfers" ALTER COLUMN "requested_at" SET NOT NULL;
ALTER TABLE "transfers" ALTER COLUMN "requested_at" SET DEFAULT now();
ALTER TABLE "transfers" ALTER COLUMN "posted_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_status_check";
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_status_check" CHECK (
    "status" IN ('pending', 'posted', 'rejected', 'cancelled')
  ),
  ADD CONSTRAINT "transfers_posted_check" CHECK (
    ("status" IN ('pending', 'rejected')) = ("posted_at" IS NULL)
  ),
  ADD CONSTRAINT "transfers_decision_check" CHECK (
    ("decided_by" IS NULL) = ("decided_at" IS NULL)
    AND ("status" <> 'rejected' OR "decision_reason" IS NOT NULL)
  ),
  -- Whoever asked never decides, in person or through a delegation they lent.
  ADD CONSTRAINT "transfers_four_eyes_check" CHECK (
    "decided_by" IS NULL OR "decided_by" IS DISTINCT FROM "requested_by"
  ),
  ADD CONSTRAINT "transfers_delegated_four_eyes_check" CHECK (
    "decided_for" IS NULL
    OR ("decided_for" IS DISTINCT FROM "requested_by" AND "decided_for" <> "decided_by")
  );
--> statement-breakpoint
GRANT UPDATE ("posted_at", "decided_by", "decided_for", "decided_at", "decision_reason")
  ON transfers TO horizon_app;
--> statement-breakpoint
-- A transfer waiting for approval has no legs; one that posts, at once or when approved,
-- has exactly its outflow and inflow — checked at commit, whatever the code forgot.
CREATE OR REPLACE FUNCTION require_transfer_legs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legs integer;
BEGIN
  SELECT count(*) INTO legs FROM journal_entries
  WHERE tenant_id = NEW.tenant_id AND transfer_id = NEW.id AND source = 'transfer'
    AND ((direction = 'outflow' AND account_id = NEW.from_account_id)
      OR (direction = 'inflow' AND account_id = NEW.to_account_id));
  IF NEW.status = 'pending' THEN
    IF legs <> 0 THEN
      RAISE EXCEPTION 'transfer % is waiting for approval and cannot have legs', NEW.id;
    END IF;
  ELSIF legs <> 2 THEN
    RAISE EXCEPTION 'transfer % must have exactly one outflow and one inflow leg', NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transfers_require_legs_on_approval AFTER UPDATE OF status ON transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'posted')
  EXECUTE FUNCTION require_transfer_legs();
--> statement-breakpoint
CREATE TABLE "transfer_approval_policies" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "threshold" bigint NOT NULL CHECK ("threshold" >= 0),
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "currency")
);
ALTER TABLE "transfer_approval_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transfer_approval_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "transfer_approval_policies" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON "transfer_approval_policies" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON "transfer_approval_policies" TO horizon_app;
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "permission" text NOT NULL CHECK ("permission" ~ '^treasury:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$'),
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
