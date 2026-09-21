-- Expand only: existing company profiles remain valid and need owner-reviewed backfill.
ALTER TABLE "tenants" ADD COLUMN "address_municipality_code" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_address_municipality_code_format"
  CHECK ("address_municipality_code" IS NULL OR "address_municipality_code" ~ '^[0-9]{7}$');
