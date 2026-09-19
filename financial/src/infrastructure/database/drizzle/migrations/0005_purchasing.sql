-- A title is raised from a document, and a purchase order and a goods receipt are as much
-- documents as a sales order is. The column is named for what it holds.
ALTER TABLE "titles" RENAME COLUMN "origin_order_id" TO "origin_document_id";
ALTER INDEX "titles_tenant_origin_order_key" RENAME TO "titles_tenant_origin_key";
--> statement-breakpoint
ALTER TABLE "titles" DROP CONSTRAINT "titles_origin_type_check";
ALTER TABLE "titles" ADD CONSTRAINT "titles_origin_type_check" CHECK (
  "origin_type" IN ('manual', 'sales-order', 'purchase-order', 'purchase-receipt')
);
--> statement-breakpoint
ALTER TABLE "titles" DROP CONSTRAINT "titles_origin_check";
ALTER TABLE "titles" ADD CONSTRAINT "titles_origin_check" CHECK (
  ("origin_type" <> 'manual') = ("origin_document_id" IS NOT NULL)
);
