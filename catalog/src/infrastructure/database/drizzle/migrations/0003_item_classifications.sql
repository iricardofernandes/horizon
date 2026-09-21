-- Expand: old item NCM remains visible, but is unverified for fiscal projection until classified.
ALTER TABLE "catalog_items" ADD COLUMN "classification_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "classification_effective_from" date;
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_classification_revision_valid" CHECK ("classification_revision" >= 0);
--> statement-breakpoint
CREATE TABLE "item_classifications" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "effective_from" date NOT NULL,
  "ncm" text,
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "item_classifications_revision_key" UNIQUE("tenant_id", "item_id", "revision"),
  CONSTRAINT "item_classifications_item_fk" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "catalog_items"("tenant_id", "id")
);
--> statement-breakpoint
ALTER TABLE "item_classifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_classifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "item_classifications" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON "item_classifications" FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON "item_classifications" TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_item_classification_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'item classification history is append-only'; END $$;
CREATE TRIGGER item_classification_immutable BEFORE UPDATE OR DELETE ON "item_classifications"
  FOR EACH ROW EXECUTE FUNCTION reject_item_classification_mutation();
