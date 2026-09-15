-- Release N: nullable and without a default, so PostgreSQL need not rewrite the table.
ALTER TABLE migration_price_lists ADD COLUMN display_name text;
--> statement-breakpoint
-- The compatibility release accepts an old writer that only knows `name` and a new
-- writer that only knows `display_name`. In production this trigger lives for the
-- whole overlap window and is removed only after every old process has drained.
CREATE FUNCTION pg_temp.sync_migration_price_list_names() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.name IS NULL AND NEW.display_name IS NULL THEN
      RAISE EXCEPTION 'a price-list name is required';
    END IF;
    NEW.name := COALESCE(NEW.name, NEW.display_name);
    NEW.display_name := COALESCE(NEW.display_name, NEW.name);
  ELSIF NEW.display_name IS NULL THEN
    -- An old binary may update an unrelated field before the backfill reaches this row.
    NEW.display_name := NEW.name;
  ELSIF NEW.name IS DISTINCT FROM OLD.name
      AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
    NEW.display_name := NEW.name;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name
      AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
    NEW.name := NEW.display_name;
  END IF;

  IF NEW.name IS DISTINCT FROM NEW.display_name THEN
    RAISE EXCEPTION 'old and new price-list names disagree';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER migration_price_list_name_compatibility
BEFORE INSERT OR UPDATE ON migration_price_lists
FOR EACH ROW EXECUTE FUNCTION pg_temp.sync_migration_price_list_names();
