-- Phase 89: whether the workspace is an IPI taxpayer for an item (it manufactures it, or is
-- equated to an industrial establishment), as part of the item's classification revision.
ALTER TABLE "catalog_items" ADD COLUMN "ipi_taxpayer" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_classifications" ADD COLUMN "ipi_taxpayer" boolean DEFAULT false NOT NULL;
