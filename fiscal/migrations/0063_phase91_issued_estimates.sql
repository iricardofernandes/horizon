-- Phase 91 (ADR 0076): every estimate Fiscal issues, kept with the request it answered. Sales
-- and Procurement keep an estimate only once Fiscal returns it by its digest and the request
-- is their document's; Fiscal compares a supplier's NF-e only with an estimate found here.
CREATE TABLE fiscal_tax_estimates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  direction text NOT NULL CHECK (direction IN ('sale', 'purchase')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  estimate jsonb NOT NULL CHECK (jsonb_typeof(estimate) = 'object'),
  estimated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, result_digest)
);

ALTER TABLE fiscal_tax_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_tax_estimates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_tax_estimates TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_tax_estimates TO horizon_app;
CREATE TRIGGER fiscal_tax_estimates_immutable
  BEFORE UPDATE OR DELETE ON fiscal_tax_estimates
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
