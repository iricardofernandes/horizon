-- Customers become a projection of the party registry (ADR 0040). A projected customer
-- carries no tax identifier, and one that stops being a customer stays referenced by
-- its documents as inactive.
ALTER TABLE "customers" ALTER COLUMN "tax_id_ciphertext" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "tax_id_index" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_status_check";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_status_check"
  CHECK (status IN ('active', 'inactive', 'erased'));
