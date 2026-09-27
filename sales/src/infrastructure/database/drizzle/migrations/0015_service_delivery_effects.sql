-- Phase 53: what the owners did with a service delivery, followed from their events
-- (ADR 0048). A delivery is never rewritten once cancelled, so its effects live apart.
CREATE TABLE "service_delivery_effects" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "delivery_id" uuid NOT NULL,
  "receivable_title_id" uuid NOT NULL,
  "receivable_posted_at" timestamptz NOT NULL,
  "receivable_reversed_at" timestamptz,
  PRIMARY KEY ("tenant_id", "delivery_id"),
  CONSTRAINT "service_delivery_effects_delivery_fk" FOREIGN KEY ("tenant_id", "delivery_id")
    REFERENCES "service_deliveries" ("tenant_id", "id")
);
CREATE INDEX "service_delivery_effects_title_idx"
  ON "service_delivery_effects" ("tenant_id", "receivable_title_id");
--> statement-breakpoint
CREATE TABLE "service_delivery_line_nfse" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "entry_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('authorized', 'rejected', 'cancelled')),
  "observed_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "entry_id"),
  CONSTRAINT "service_delivery_line_nfse_line_fk" FOREIGN KEY ("tenant_id", "entry_id")
    REFERENCES "service_delivery_lines" ("tenant_id", "entry_id")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['service_delivery_effects', 'service_delivery_line_nfse'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON service_delivery_effects, service_delivery_line_nfse FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON service_delivery_effects, service_delivery_line_nfse TO horizon_app;
