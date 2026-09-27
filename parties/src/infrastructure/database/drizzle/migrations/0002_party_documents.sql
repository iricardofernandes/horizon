-- Phase 54 (ADR 0057): a party's document is typed, and contact fields follow its roles.
-- Every existing party was registered with a CPF (person) or a CNPJ (organization), which
-- the kind already records, so the type is derived without opening any ciphertext and
-- the existing blind indexes stay valid unchanged.
ALTER TABLE "parties" ADD COLUMN "document_type" text;
--> statement-breakpoint
-- The owner is subject to forced RLS like everyone else, so the backfill lifts it for this
-- statement only: without that the update sees no tenant's rows.
ALTER TABLE "parties" NO FORCE ROW LEVEL SECURITY;
UPDATE "parties" SET "document_type" = CASE "kind" WHEN 'organization' THEN 'cnpj' ELSE 'cpf' END;
ALTER TABLE "parties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "parties" ALTER COLUMN "document_type" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "document_country" text;
--> statement-breakpoint
ALTER TABLE "parties" ALTER COLUMN "tax_id_ciphertext" DROP NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "tax_id_index" DROP NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "email_ciphertext" DROP NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "phone_ciphertext" DROP NOT NULL;
ALTER TABLE "parties" ALTER COLUMN "address_ciphertext" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_document_type_valid"
  CHECK ("document_type" IN ('cpf', 'cnpj', 'foreign', 'none'));
ALTER TABLE "parties" ADD CONSTRAINT "parties_document_country_valid"
  CHECK (("document_type" = 'foreign') = ("document_country" IS NOT NULL)
    AND ("document_country" IS NULL OR "document_country" ~ '^[A-Z]{2}$'));
-- An erased party keeps no usable index; a live one has a document exactly when it is typed.
ALTER TABLE "parties" ADD CONSTRAINT "parties_document_present"
  CHECK ("status" = 'erased'
    OR (("document_type" = 'none') = ("tax_id_ciphertext" IS NULL)
      AND ("tax_id_ciphertext" IS NULL) = ("tax_id_index" IS NULL)));
ALTER TABLE "parties" ADD CONSTRAINT "parties_document_kind_valid"
  CHECK (("document_type" <> 'cpf' OR "kind" = 'person')
    AND ("document_type" <> 'cnpj' OR "kind" = 'organization'));
--> statement-breakpoint
-- Keyed blind indexes for the duplicate check. Older rows are filled by
-- `npm run backfill:party-lookups`; until then they are invisible to the check only.
ALTER TABLE "parties" ADD COLUMN "name_index" text;
ALTER TABLE "parties" ADD COLUMN "email_index" text;
ALTER TABLE "parties" ADD COLUMN "phone_index" text;
--> statement-breakpoint
CREATE INDEX "parties_tenant_name_index_idx" ON "parties" ("tenant_id", "name_index") WHERE "name_index" IS NOT NULL;
CREATE INDEX "parties_tenant_email_index_idx" ON "parties" ("tenant_id", "email_index") WHERE "email_index" IS NOT NULL;
CREATE INDEX "parties_tenant_phone_index_idx" ON "parties" ("tenant_id", "phone_index") WHERE "phone_index" IS NOT NULL;
