-- Until now the warehouse could say how many it held. It could not say which ones — and
-- for a batch that can be recalled, or a jar that goes off, which ones is the only
-- question worth asking. Identifying goods costs a picker time at every movement, so it
-- is a decision taken item by item rather than a column every item carries.
--
-- `serial` is deliberately not a value here. Naming every single unit is a different
-- shape of answer, not a stricter version of this one, and a workspace must not be able
-- to switch on a control the module does not yet honour.
CREATE TABLE "item_tracking" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "tracking" text NOT NULL CHECK ("tracking" IN ('none', 'lot')),
  "expiry" text NOT NULL CHECK ("expiry" IN ('none', 'optional', 'required')),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "item_id"),
  -- An item nobody identifies has no expiry rule to enforce: there is nothing to put a
  -- date on.
  CONSTRAINT "item_tracking_expiry_needs_lots_check" CHECK (
    "tracking" <> 'none' OR "expiry" = 'none'
  )
);
--> statement-breakpoint
-- Which boxes a shelf is holding. What these add up to is what the balance has on hand,
-- asserted below by a trigger as well as by the aggregate: a warehouse whose lots
-- disagree with its balance can answer neither question honestly.
CREATE TABLE "stock_lots" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "balance_id" uuid NOT NULL,
  "lot_code" text NOT NULL CHECK (char_length("lot_code") BETWEEN 1 AND 60),
  "on_hand" bigint NOT NULL CHECK ("on_hand" > 0),
  "expires_on" date,
  "first_received_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "balance_id", "lot_code"),
  CONSTRAINT "stock_lots_balance_fk" FOREIGN KEY ("tenant_id", "balance_id") REFERENCES "stock_balances"("tenant_id", "id")
);
--> statement-breakpoint
-- A lot that has run out stops being a holding, so every row here is stock somebody can
-- walk up to. Where an emptied lot went stays in the movements.
CREATE INDEX "stock_lots_tenant_expiry_idx" ON "stock_lots" ("tenant_id", "expires_on");
--> statement-breakpoint
-- Which boxes a movement touched: the thread a recall is pulled by. Append-only, like the
-- movement it belongs to.
CREATE TABLE "stock_movement_lots" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "movement_id" uuid NOT NULL REFERENCES "stock_movements"("id"),
  "lot_code" text NOT NULL CHECK (char_length("lot_code") BETWEEN 1 AND 60),
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "expires_on" date,
  PRIMARY KEY ("tenant_id", "movement_id", "lot_code")
);
--> statement-breakpoint
CREATE INDEX "stock_movement_lots_trace_idx" ON "stock_movement_lots" ("tenant_id", "lot_code");
--> statement-breakpoint
-- A sale and a purchase always had a document behind them; the movement simply never
-- named it, because the kind was thought to be explanation enough. It is not, once
-- somebody has to answer where a particular box went.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN
    ('sale', 'purchase', 'transfer', 'count', 'breakage', 'loss', 'theft', 'expiry', 'found', 'correction')
);
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_document_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_check" CHECK (
  ("document_type" IS NULL) = ("document_id" IS NULL)
  AND ("document_type" IS NULL OR "document_type" IN ('order', 'receipt', 'transfer', 'adjustment', 'count'))
);
--> statement-breakpoint
-- A write-off of a tracked item is a write-off of particular boxes, and the second
-- person is being asked about those boxes: "write off four" and "write off four of
-- AB-1204" are not the same request, so the lot is named when it is asked for.
ALTER TABLE "stock_adjustments" ADD COLUMN "lot_code" text CHECK ("lot_code" IS NULL OR char_length("lot_code") BETWEEN 1 AND 60);
--> statement-breakpoint
-- A lot-tracked item is counted lot by lot: the useful answer is not that the shelf is
-- two short but that lot AB-1204 is. The sheet therefore has more than one line per item,
-- so the natural key gains the lot and the row gains an identity of its own.
ALTER TABLE "stock_count_lines" ADD COLUMN "id" uuid;
ALTER TABLE "stock_count_lines" ADD COLUMN "lot_code" text CHECK ("lot_code" IS NULL OR char_length("lot_code") BETWEEN 1 AND 60);
--> statement-breakpoint
-- Sheets written before lots existed counted the item as a whole, which is exactly what a
-- null lot means, so the backfill only has to give each line the identity it now needs.
-- The owner is under forced RLS like everyone else, so the policy comes off for the
-- length of the update and goes straight back on.
ALTER TABLE "stock_count_lines" NO FORCE ROW LEVEL SECURITY;
UPDATE "stock_count_lines" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "stock_count_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stock_count_lines" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "stock_count_lines" DROP CONSTRAINT "stock_count_lines_pkey";
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id");
-- NULLS NOT DISTINCT so an untracked item cannot be frozen onto the same sheet twice:
-- two rows with no lot are the same line, not two different ones.
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_sheet_key"
  UNIQUE NULLS NOT DISTINCT ("tenant_id", "count_id", "item_id", "lot_code");
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['item_tracking','stock_lots','stock_movement_lots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON item_tracking, stock_lots, stock_movement_lots FROM horizon_app, horizon_relay;
-- A tracking decision is restated, never withdrawn: an item that was identified and is
-- now not would leave stock nobody can account for.
GRANT SELECT, INSERT ON item_tracking TO horizon_app;
GRANT UPDATE ("tracking", "expiry", "updated_by", "updated_at") ON item_tracking TO horizon_app;
-- A lot's quantity moves and a lot that empties is deleted, because a holding of nothing
-- is not a holding. Its code and its dates are not rewritten.
GRANT SELECT, INSERT, DELETE ON stock_lots TO horizon_app;
GRANT UPDATE ("on_hand") ON stock_lots TO horizon_app;
-- What a movement touched is written once, with the movement.
GRANT SELECT, INSERT ON stock_movement_lots TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_inventory_movement_lot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'what a movement touched cannot be changed'; END $$;
CREATE TRIGGER stock_movement_lots_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movement_lots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_movement_lot_mutation();
--> statement-breakpoint
-- The invariant the whole idea rests on: a tracked balance holds exactly what its lots
-- add up to. Deferred to the end of the transaction, because the two sides are written by
-- separate statements and are only required to agree once the command is done.
CREATE FUNCTION assert_inventory_lots_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance record;
  lot_total bigint;
BEGIN
  SELECT b.id, b.on_hand INTO balance FROM stock_balances b
    WHERE b.id = COALESCE(NEW.balance_id, OLD.balance_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(l.on_hand), 0) INTO lot_total FROM stock_lots l WHERE l.balance_id = balance.id;
  -- Zero lots is how an untracked balance looks, and it is allowed to hold anything.
  IF lot_total <> 0 AND lot_total <> balance.on_hand THEN
    RAISE EXCEPTION 'the lots of balance % hold % but the balance holds %',
      balance.id, lot_total, balance.on_hand;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_lots_agree_with_balance
  AFTER INSERT OR UPDATE OR DELETE ON stock_lots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_inventory_lots_balance();
