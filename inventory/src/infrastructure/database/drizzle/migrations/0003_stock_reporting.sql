-- The movement table has always been able to say how many there are on any past day:
-- every movement carries the balance it left behind. It has never been able to say what
-- they were worth, because a unit's worth is the balance's moving average and no movement
-- recorded it. This phase asks the table to answer both, so it gains the column it should
-- always have carried.
ALTER TABLE "stock_movements" ADD COLUMN "average_after" bigint;
--> statement-breakpoint
-- Movements are append-only, and this is the one edit that is not a rewriting of history:
-- a derived figure is being put where it always belonged, computed from the rows
-- themselves. The guard and the tenant policy come off for the length of the backfill and
-- go straight back on; nothing outside this transaction can see them down.
ALTER TABLE "stock_movements" DISABLE TRIGGER "stock_movements_append_only";
ALTER TABLE "stock_movements" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The same arithmetic the aggregate does, replayed in the order the balance saw it:
-- goods arriving at a stated cost are averaged into what was already there, rounded half
-- up; everything else leaves a unit's worth exactly as it found it.
--
-- A shelf whose history does not start at the beginning — one seeded with stock before a
-- movement was ever written — is anchored by the first thing to leave it, because goods
-- leaving are priced at the very average they do not change. That is the only figure the
-- rows themselves can offer, and it is the right one. What no row can say is what stock
-- put on a shelf before the ledger began was worth, so a chain that opens with a receipt
-- onto an already-full shelf values that opening at nothing; the balance table, not this
-- column, remains the authority on such a shelf until the next thing leaves it.
WITH RECURSIVE ordered AS (
  SELECT
    "id",
    "balance_id",
    "kind",
    "quantity",
    "balance_after",
    "unit_cost",
    row_number() OVER (PARTITION BY "balance_id" ORDER BY "balance_version") AS step
  FROM "stock_movements"
),
replayed AS (
  SELECT
    o."id",
    o."balance_id",
    o.step,
    CASE
      WHEN o."unit_cost" IS NOT NULL
        AND o."kind" IN ('receipt', 'transfer-in', 'adjustment-in')
        AND o."balance_after" > 0
      THEN trunc((o."quantity"::numeric * o."unit_cost" + trunc(o."balance_after"::numeric / 2))
                 / o."balance_after"::numeric)::bigint
      ELSE o."unit_cost"
    END AS average_after
  FROM ordered o
  WHERE o.step = 1
  UNION ALL
  SELECT
    o."id",
    o."balance_id",
    o.step,
    CASE
      WHEN o."unit_cost" IS NOT NULL
        AND o."kind" IN ('receipt', 'transfer-in', 'adjustment-in')
        AND o."balance_after" > 0
      THEN trunc(((o."balance_after" - o."quantity")::numeric * coalesce(r.average_after, 0)
                   + o."quantity"::numeric * o."unit_cost"
                   + trunc(o."balance_after"::numeric / 2))
                 / o."balance_after"::numeric)::bigint
      ELSE coalesce(r.average_after, o."unit_cost")
    END AS average_after
  FROM ordered o
  JOIN replayed r ON r."balance_id" = o."balance_id" AND o.step = r.step + 1
)
UPDATE "stock_movements" m
  SET "average_after" = r.average_after
  FROM replayed r
  WHERE r."id" = m."id" AND r.average_after IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_append_only";
--> statement-breakpoint
-- Goods that moved at a cost left a balance that has one: an out-movement is priced at
-- the very average it did not change, and an in-movement sets the average it is priced
-- into. The reverse does not hold — goods can arrive worth nothing onto a shelf that
-- already has an average, and then the movement has no cost but the shelf still does.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_average_after_check" CHECK (
  ("average_after" IS NULL OR "average_after" >= 0)
  AND ("unit_cost" IS NULL OR "average_after" IS NOT NULL)
);
--> statement-breakpoint
-- A Kardex reads one shelf from end to end, and a valuation reads every shelf as it was
-- on one day. Neither is served by the item index alone.
CREATE INDEX "stock_movements_tenant_balance_idx" ON "stock_movements" ("tenant_id", "balance_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_occurred_idx" ON "stock_movements" ("tenant_id", "occurred_at");
--> statement-breakpoint
-- How little of an item a warehouse should get down to, and how much is too much. A level
-- is a target, never a control: nothing refuses a movement for crossing one, and the only
-- thing that reads it is a report saying which shelves need attention. There is no row
-- meaning "no level" — a minimum of zero is how a workspace says it does not want to hear
-- about this item, and it says so on the record rather than by deleting one.
CREATE TABLE "stock_levels" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "minimum" bigint NOT NULL CHECK ("minimum" >= 0),
  "maximum" bigint CHECK ("maximum" IS NULL OR "maximum" >= 0),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "warehouse_id", "item_id"),
  CONSTRAINT "stock_levels_range_check" CHECK ("maximum" IS NULL OR "maximum" >= "minimum"),
  CONSTRAINT "stock_levels_warehouse_fk" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
ALTER TABLE "stock_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_levels" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "stock_levels" TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON stock_levels FROM horizon_app, horizon_relay;
-- A level is restated, never withdrawn.
GRANT SELECT, INSERT ON stock_levels TO horizon_app;
GRANT UPDATE ("minimum", "maximum", "updated_by", "updated_at") ON stock_levels TO horizon_app;
