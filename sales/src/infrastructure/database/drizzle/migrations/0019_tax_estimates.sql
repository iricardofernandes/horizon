-- Phase 87 (ADR 0073): Fiscal's tax estimate of a quote or an order, as the web handed it to
-- Sales: components, totals and digests, labeled an estimate and never a tax owed. A confirmed
-- order keeps the last one it was given.
CREATE TABLE "tax_estimates" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "document_kind" text NOT NULL CHECK ("document_kind" IN ('quote', 'order')),
  "document_id" uuid NOT NULL,
  "estimate" jsonb NOT NULL CHECK (jsonb_typeof("estimate") = 'object'),
  "input_digest" text NOT NULL CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  "rules_digest" text NOT NULL CHECK ("rules_digest" ~ '^[0-9a-f]{64}$'),
  "result_digest" text NOT NULL CHECK ("result_digest" ~ '^[0-9a-f]{64}$'),
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "document_kind", "document_id")
);
--> statement-breakpoint
ALTER TABLE "tax_estimates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_estimates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "tax_estimates" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON tax_estimates FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON tax_estimates TO horizon_app;
