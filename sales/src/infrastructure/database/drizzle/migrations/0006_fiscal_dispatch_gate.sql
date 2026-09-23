CREATE TABLE sales_fiscal_dispatch_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  warehouse_id uuid NOT NULL,
  establishment_id uuid NOT NULL,
  required_environment text NOT NULL DEFAULT 'production'
    CHECK (required_environment = 'production'),
  reason text NOT NULL CHECK (length(reason) >= 10),
  created_by text NOT NULL CHECK (length(created_by) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, warehouse_id)
);
--> statement-breakpoint
CREATE TABLE sales_fiscal_origin_freezes (
  tenant_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_version integer NOT NULL CHECK (order_version > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shipment_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id)
);
--> statement-breakpoint
CREATE TABLE sales_fiscal_release_observations (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  origin_digest text NOT NULL CHECK (origin_digest ~ '^[0-9a-f]{64}$'),
  order_version integer NOT NULL CHECK (order_version > 0),
  document_id uuid NOT NULL,
  document_revision integer NOT NULL CHECK (document_revision > 0),
  environment text NOT NULL CHECK (environment = 'production'),
  outcome text NOT NULL CHECK (outcome IN ('authorized', 'rejected', 'cancelled')),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id)
);
--> statement-breakpoint
CREATE INDEX sales_fiscal_release_latest ON sales_fiscal_release_observations
  (tenant_id, shipment_id, observed_at DESC, event_id DESC);
--> statement-breakpoint
ALTER TABLE sales_fiscal_dispatch_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_fiscal_dispatch_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_fiscal_origin_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_fiscal_origin_freezes FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_fiscal_release_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_fiscal_release_observations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON sales_fiscal_dispatch_policies TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON sales_fiscal_origin_freezes TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
CREATE POLICY tenant_scope ON sales_fiscal_release_observations TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON sales_fiscal_dispatch_policies, sales_fiscal_origin_freezes,
  sales_fiscal_release_observations FROM horizon_app, horizon_relay;
GRANT SELECT ON sales_fiscal_dispatch_policies TO horizon_app;
GRANT SELECT, INSERT ON sales_fiscal_origin_freezes TO horizon_app;
GRANT SELECT, INSERT ON sales_fiscal_release_observations TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_sales_fiscal_gate_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fiscal gate evidence is append-only'; END $$;
CREATE TRIGGER sales_fiscal_policy_immutable BEFORE UPDATE OR DELETE
  ON sales_fiscal_dispatch_policies FOR EACH ROW EXECUTE FUNCTION reject_sales_fiscal_gate_mutation();
CREATE TRIGGER sales_fiscal_freeze_immutable BEFORE UPDATE OR DELETE
  ON sales_fiscal_origin_freezes FOR EACH ROW EXECUTE FUNCTION reject_sales_fiscal_gate_mutation();
CREATE TRIGGER sales_fiscal_release_immutable BEFORE UPDATE OR DELETE
  ON sales_fiscal_release_observations FOR EACH ROW EXECUTE FUNCTION reject_sales_fiscal_gate_mutation();
