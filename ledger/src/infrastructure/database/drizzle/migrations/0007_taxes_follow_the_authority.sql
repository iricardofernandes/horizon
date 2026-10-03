-- Phase 91 (ADR 0076): a document's taxes are posted when the authority authorizes it, and
-- reversed when it cancels it; a rejected document never posts. Until the answer, its lock
-- waits as a `held` fact, which is neither posted nor replayed.
ALTER TABLE "posting_facts" DROP CONSTRAINT "posting_facts_status_check";
ALTER TABLE "posting_facts" ADD CONSTRAINT "posting_facts_status_check" CHECK (
  "status" IN ('posted', 'pending', 'reversed', 'ignored', 'held')
);
--> statement-breakpoint
-- The authority's answer for each Fiscal document. It may arrive before the lock it decides,
-- so it is kept: the lock then finds it. It only moves forward, from an authorization to a
-- cancellation; a rejection and a cancellation are final.
CREATE TABLE "fiscal_document_outcomes" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "document_id" uuid NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('authorized', 'rejected', 'cancelled')),
  "observed_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "document_id")
);
--> statement-breakpoint
ALTER TABLE "fiscal_document_outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_document_outcomes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "fiscal_document_outcomes" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON "fiscal_document_outcomes" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "fiscal_document_outcomes" TO horizon_app;
GRANT UPDATE ("outcome", "observed_at", "updated_at") ON "fiscal_document_outcomes" TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_backward_document_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.outcome = 'authorized' AND NEW.outcome = 'cancelled') THEN
    RAISE EXCEPTION 'document % was % and cannot become %', OLD.document_id, OLD.outcome, NEW.outcome;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_document_outcomes_forward BEFORE UPDATE OF "outcome" ON "fiscal_document_outcomes"
  FOR EACH ROW EXECUTE FUNCTION reject_backward_document_outcome();
