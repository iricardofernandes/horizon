-- A lot says these goods arrived together and are alike. That is the whole answer for a
-- pallet of flour, and no answer at all for a machine: the one a customer rings up about
-- in two years is a particular machine, not one of a batch. Naming every unit is the other
-- shape of the same question, which is why it is a third value here rather than a stricter
-- setting of the second.
ALTER TABLE "item_tracking" DROP CONSTRAINT "item_tracking_tracking_check";
ALTER TABLE "item_tracking" ADD CONSTRAINT "item_tracking_tracking_check" CHECK (
  "tracking" IN ('none', 'lot', 'serial')
);
--> statement-breakpoint
-- A date belongs to a batch, not to a unit. What goes off is a jar of something; the
-- answer for a machine due a service is a service record, not an expiry that would
-- quietly make the machine unsellable.
ALTER TABLE "item_tracking" DROP CONSTRAINT "item_tracking_expiry_needs_lots_check";
ALTER TABLE "item_tracking" ADD CONSTRAINT "item_tracking_expiry_needs_lots_check" CHECK (
  "tracking" = 'lot' OR "expiry" = 'none'
);
--> statement-breakpoint
-- Every unit the workspace has ever named, and where it is now. One row per serial per
-- item, for good: a unit that has been sold keeps its name, because the machine that comes
-- back in a year is the same machine and a warehouse that gave the name away in the
-- meantime has lost the only thread it had.
--
-- `balance_id` says which shelf it is on and is null once it has gone, so a unit is in
-- stock in at most one place by construction rather than by a rule anybody must remember.
CREATE TABLE "stock_serials" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "serial" text NOT NULL CHECK (char_length("serial") BETWEEN 1 AND 80),
  "balance_id" uuid,
  "status" text NOT NULL CHECK ("status" IN ('in-stock', 'shipped', 'returned', 'scrapped')),
  "received_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "item_id", "serial"),
  -- On a shelf exactly when it is in stock, and on none when it is not. Neither half of
  -- that can drift without the other saying something false.
  CONSTRAINT "stock_serials_whereabouts_check" CHECK (
    ("status" = 'in-stock') = ("balance_id" IS NOT NULL)
  ),
  CONSTRAINT "stock_serials_balance_fk" FOREIGN KEY ("tenant_id", "balance_id") REFERENCES "stock_balances"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "stock_serials_tenant_balance_idx" ON "stock_serials" ("tenant_id", "balance_id");
--> statement-breakpoint
CREATE INDEX "stock_serials_tenant_serial_idx" ON "stock_serials" ("tenant_id", "serial");
--> statement-breakpoint
-- Which units a movement touched: the thread for goods named one at a time, beside the
-- one lots already have. Append-only, like the movement it belongs to.
CREATE TABLE "stock_movement_serials" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "movement_id" uuid NOT NULL REFERENCES "stock_movements"("id"),
  "serial" text NOT NULL CHECK (char_length("serial") BETWEEN 1 AND 80),
  PRIMARY KEY ("tenant_id", "movement_id", "serial")
);
--> statement-breakpoint
CREATE INDEX "stock_movement_serials_trace_idx" ON "stock_movement_serials" ("tenant_id", "serial");
--> statement-breakpoint
-- A write-off of three machines is one decision about three machines; splitting it into
-- three requests would ask the second person the same question three times. A lot and a
-- list of units are two ways of saying which goods, so an adjustment says at most one.
ALTER TABLE "stock_adjustments" ADD COLUMN "serials" text[];
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_named_once_check" CHECK (
  "lot_code" IS NULL OR "serials" IS NULL OR cardinality("serials") = 0
);
--> statement-breakpoint
-- A machine is counted by looking for it: one line per unit, each expecting the one of it
-- there is, and counting zero is how a counter says it is not where the system thinks.
ALTER TABLE "stock_count_lines" ADD COLUMN "serial" text CHECK ("serial" IS NULL OR char_length("serial") BETWEEN 1 AND 80);
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_named_once_check" CHECK (
  "lot_code" IS NULL OR "serial" IS NULL
);
ALTER TABLE "stock_count_lines" DROP CONSTRAINT "stock_count_lines_sheet_key";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_sheet_key"
  UNIQUE NULLS NOT DISTINCT ("tenant_id", "count_id", "item_id", "lot_code", "serial");
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['stock_serials','stock_movement_serials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON stock_serials, stock_movement_serials FROM horizon_app, horizon_relay;
-- A unit's name and the day it first arrived are written once; where it is and how it is
-- doing change for as long as it exists. It is never deleted: a name that was given away
-- would break the only thread there is.
GRANT SELECT, INSERT ON stock_serials TO horizon_app;
GRANT UPDATE ("balance_id", "status", "updated_at") ON stock_serials TO horizon_app;
GRANT SELECT, INSERT ON stock_movement_serials TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_inventory_movement_serial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'what a movement touched cannot be changed'; END $$;
CREATE TRIGGER stock_movement_serials_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movement_serials
  FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_movement_serial_mutation();
--> statement-breakpoint
-- The same invariant lots answer to: a shelf holds exactly as many named units as its
-- balance says. Deferred, because the two sides are written by separate statements and are
-- only required to agree once the command is done.
--
-- Asked of the item's policy rather than of whether any rows happen to exist. "No units
-- named" is a perfectly good state for an untracked shelf and a lie on a tracked one, and
-- a check that could not tell them apart would let a unit turn up on a second shelf while
-- the first quietly kept counting it.
CREATE FUNCTION assert_inventory_serials_on(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  shelf record;
  named bigint;
BEGIN
  IF target IS NULL THEN RETURN; END IF;
  SELECT b.on_hand, coalesce(t.tracking, 'none') AS tracking INTO shelf
    FROM stock_balances b
    LEFT JOIN item_tracking t ON t.tenant_id = b.tenant_id AND t.item_id = b.item_id
    WHERE b.id = target;
  IF NOT FOUND OR shelf.tracking <> 'serial' THEN RETURN; END IF;
  SELECT count(*) INTO named FROM stock_serials s
    WHERE s.balance_id = target AND s.status = 'in-stock';
  IF named * 1000000 <> shelf.on_hand THEN
    RAISE EXCEPTION 'balance % holds % but % units are named on it',
      target, shelf.on_hand, named;
  END IF;
END $$;
--> statement-breakpoint
-- Both sides of the change, not just the new one. A unit that turned up on a second shelf
-- leaves the first one short, and checking only where it arrived would never notice.
CREATE FUNCTION assert_inventory_serials_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN PERFORM assert_inventory_serials_on(NEW.balance_id); END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM assert_inventory_serials_on(OLD.balance_id); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_serials_agree_with_balance
  AFTER INSERT OR UPDATE OR DELETE ON stock_serials
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_inventory_serials_balance();
--> statement-breakpoint
-- The lot check has the same hole, found while closing this one: a lot-tracked shelf that
-- lost every lot row would pass, because zero lots is also how an untracked shelf looks.
-- The item's policy is what tells the two apart.
CREATE OR REPLACE FUNCTION assert_inventory_lots_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.balance_id, OLD.balance_id);
  shelf record;
  lot_total bigint;
BEGIN
  SELECT b.on_hand, coalesce(t.tracking, 'none') AS tracking INTO shelf
    FROM stock_balances b
    LEFT JOIN item_tracking t ON t.tenant_id = b.tenant_id AND t.item_id = b.item_id
    WHERE b.id = target;
  IF NOT FOUND OR shelf.tracking <> 'lot' THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(l.on_hand), 0) INTO lot_total FROM stock_lots l WHERE l.balance_id = target;
  IF lot_total <> shelf.on_hand THEN
    RAISE EXCEPTION 'the lots of balance % hold % but the balance holds %',
      target, lot_total, shelf.on_hand;
  END IF;
  RETURN NULL;
END $$;
