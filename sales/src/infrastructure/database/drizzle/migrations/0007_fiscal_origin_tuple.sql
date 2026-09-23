ALTER TABLE sales_fiscal_origin_freezes
  ADD COLUMN establishment_id uuid,
  ADD COLUMN warehouse_id uuid;
--> statement-breakpoint
ALTER TABLE sales_fiscal_release_observations
  ADD COLUMN establishment_id uuid;
