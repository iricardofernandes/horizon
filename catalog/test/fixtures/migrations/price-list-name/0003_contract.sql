-- Release N+2: safe only after the old binary, workers and queued work have drained.
DROP TRIGGER migration_price_list_name_compatibility ON migration_price_lists;
--> statement-breakpoint
DROP FUNCTION pg_temp.sync_migration_price_list_names();
--> statement-breakpoint
ALTER TABLE migration_price_lists
  DROP CONSTRAINT migration_price_lists_tenant_name_key;
--> statement-breakpoint
ALTER TABLE migration_price_lists DROP COLUMN name;
