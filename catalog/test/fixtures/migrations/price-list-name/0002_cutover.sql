-- Release N+1: validate existing data before making the new invariant immediate.
ALTER TABLE migration_price_lists
  ADD CONSTRAINT migration_price_lists_display_name_present
  CHECK (display_name IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE migration_price_lists
  VALIDATE CONSTRAINT migration_price_lists_display_name_present;
--> statement-breakpoint
ALTER TABLE migration_price_lists ALTER COLUMN display_name SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX migration_price_lists_tenant_display_name_key
  ON migration_price_lists (tenant_id, display_name);
--> statement-breakpoint
ALTER TABLE migration_price_lists
  DROP CONSTRAINT migration_price_lists_display_name_present;
