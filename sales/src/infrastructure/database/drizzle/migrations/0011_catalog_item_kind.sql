-- Phase 49: Sales learns whether an item is a good or a service. The Catalog kind is
-- immutable, so a recorded kind never changes; NULL means "projected before Phase 49" and
-- keeps today's behaviour (a product) until the backfill fills it.
ALTER TABLE catalog_items
  ADD COLUMN kind text CHECK (kind IN ('product', 'service'));
--> statement-breakpoint
CREATE INDEX catalog_items_unknown_kind ON catalog_items (tenant_id, item_id) WHERE kind IS NULL;
