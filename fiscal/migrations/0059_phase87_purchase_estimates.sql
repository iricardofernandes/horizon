-- Phase 87 (ADR 0073): Fiscal's estimate of a purchase order's taxes, as the approved order
-- carried it, so the supplier's NF-e can be compared with it component by component. A
-- read-only projection of Procurement's fact; Fiscal never writes back.
CREATE TABLE fiscal_purchase_order_estimates (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'array'),
  charged_on_top_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  rules_digest text NOT NULL CHECK (rules_digest ~ '^[0-9a-f]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, order_id)
);

ALTER TABLE fiscal_purchase_order_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_purchase_order_estimates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_purchase_order_estimates TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_purchase_order_estimates TO horizon_app;
CREATE TRIGGER fiscal_purchase_order_estimates_immutable
  BEFORE UPDATE OR DELETE ON fiscal_purchase_order_estimates
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
