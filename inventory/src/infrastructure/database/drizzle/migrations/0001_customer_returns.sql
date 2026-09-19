-- Goods can now come back from a customer, which is neither a purchase nor an adjustment:
-- the stock returns at the cost it left at, into the promise it was shipped against.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  "kind" IN ('receipt', 'shipment', 'adjustment-in', 'adjustment-out', 'return-in')
);
--> statement-breakpoint
-- A reservation is no longer consumed the moment the order is confirmed: it is consumed
-- when the goods leave, which can happen in parts.
ALTER TABLE "stock_reservations" DROP CONSTRAINT "stock_reservations_status_check";
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_status_check" CHECK (
  "status" IN ('active', 'confirmed', 'shipped', 'released')
);
--> statement-breakpoint
ALTER TABLE "stock_reservation_lines" ADD COLUMN "shipped" bigint NOT NULL DEFAULT 0
  CHECK ("shipped" >= 0);
ALTER TABLE "stock_reservation_lines" ALTER COLUMN "shipped" DROP DEFAULT;
-- What has left is the only thing about a held line that ever changes.
GRANT UPDATE ("shipped") ON "stock_reservation_lines" TO horizon_app;
--> statement-breakpoint
-- Nothing leaves twice: what has gone never exceeds what was held.
ALTER TABLE "stock_reservation_lines" ADD CONSTRAINT "stock_reservation_lines_within_hold_check"
  CHECK ("shipped" <= "quantity");
-- A reservation confirmed before deliveries existed shipped everything it held, because
-- confirming is what took the stock out at the time.
ALTER TABLE "stock_reservations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_reservation_lines" NO FORCE ROW LEVEL SECURITY;
UPDATE "stock_reservation_lines" SET "shipped" = "quantity" WHERE "reservation_id" IN (
  SELECT "id" FROM "stock_reservations" WHERE "status" = 'confirmed'
);
UPDATE "stock_reservations" SET "status" = 'shipped' WHERE "status" = 'confirmed';
ALTER TABLE "stock_reservation_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "stock_reservations" FORCE ROW LEVEL SECURITY;
