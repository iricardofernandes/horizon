-- The warehouse has been able to say what it holds, what it held, which boxes and which
-- units. What it has never been able to do is make anything. A production order is the one
-- document that takes goods off the shelf and puts different goods back, and the only
-- promise worth making about it is that nothing is created or lost in between.
--
-- What the catalogue says an item is made of, as this module heard it. A copy rather than
-- a question asked across a boundary: an order has to be releasable when the catalogue is
-- down, and the version it was released under has to stay readable after the catalogue has
-- moved on.
CREATE TABLE "item_compositions" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "parent_item_id" uuid NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "realisation" text NOT NULL CHECK ("realisation" IN ('assembled', 'exploded')),
  "effective_from" date NOT NULL,
  "received_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "parent_item_id", "version")
);
--> statement-breakpoint
CREATE INDEX "item_compositions_effective_idx" ON "item_compositions" ("tenant_id", "parent_item_id", "effective_from");
--> statement-breakpoint
CREATE TABLE "item_composition_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "parent_item_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "component_item_id" uuid NOT NULL,
  -- How much of the component goes into **one** of the parent; the order multiplies it.
  "per_unit" bigint NOT NULL CHECK ("per_unit" > 0),
  PRIMARY KEY ("tenant_id", "parent_item_id", "version", "component_item_id")
);
--> statement-breakpoint
CREATE TABLE "production_orders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "status" text NOT NULL CHECK ("status" IN ('planned', 'released', 'finished', 'cancelled')),
  -- Frozen at release, so a recipe that changes later cannot rewrite this batch.
  "composition_version" integer,
  "produced" bigint NOT NULL DEFAULT 0 CHECK ("produced" >= 0),
  "conversion_cost" bigint CHECK ("conversion_cost" IS NULL OR "conversion_cost" >= 0),
  "conversion_currency" text CHECK ("conversion_currency" IS NULL OR "conversion_currency" ~ '^[A-Z]{3}$'),
  "subcontractor_party_id" uuid,
  "note" text,
  "opened_by" text NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "released_at" timestamptz,
  "finished_at" timestamptz,
  "closure_reason" text,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "production_orders_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "production_orders_conversion_pair_check" CHECK (
    ("conversion_cost" IS NULL) = ("conversion_currency" IS NULL)
  ),
  -- A released order has a recipe behind it; a planned one has not been given its yet.
  CONSTRAINT "production_orders_released_has_recipe_check" CHECK (
    "status" IN ('planned', 'cancelled') OR "composition_version" IS NOT NULL
  ),
  -- Nothing is made before the order is released, and nothing after it is finished.
  CONSTRAINT "production_orders_produced_when_finished_check" CHECK (
    "produced" = 0 OR "status" = 'finished'
  ),
  CONSTRAINT "production_orders_warehouse_fk" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouses"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "production_orders_tenant_status_idx" ON "production_orders" ("tenant_id", "status", "opened_at");
--> statement-breakpoint
CREATE TABLE "production_order_components" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "order_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "expected" bigint NOT NULL CHECK ("expected" >= 0),
  "issued" bigint NOT NULL DEFAULT 0 CHECK ("issued" >= 0),
  "issued_value" bigint CHECK ("issued_value" IS NULL OR "issued_value" >= 0),
  "scrapped" bigint NOT NULL DEFAULT 0 CHECK ("scrapped" >= 0),
  "scrapped_value" bigint CHECK ("scrapped_value" IS NULL OR "scrapped_value" >= 0),
  "currency" text CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  PRIMARY KEY ("tenant_id", "order_id", "item_id"),
  -- The floor cannot lose what it never had.
  CONSTRAINT "production_order_components_scrap_check" CHECK ("scrapped" <= "issued"),
  CONSTRAINT "production_order_components_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "production_orders"("tenant_id", "id")
);
--> statement-breakpoint
-- Material turning into product is neither an adjustment nor a sale: nothing was lost and
-- nobody was billed. The ledger says so rather than leaving a reader to infer it.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  "kind" IN ('receipt', 'shipment', 'adjustment-in', 'adjustment-out', 'return-in',
             'transfer-in', 'transfer-out', 'production-out', 'production-in')
);
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN
    ('sale', 'purchase', 'production', 'transfer', 'count', 'breakage', 'loss', 'theft',
     'expiry', 'found', 'correction')
);
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_document_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_check" CHECK (
  ("document_type" IS NULL) = ("document_id" IS NULL)
  AND ("document_type" IS NULL OR "document_type" IN
       ('order', 'receipt', 'production-order', 'transfer', 'adjustment', 'count'))
);
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['item_compositions','item_composition_lines','production_orders','production_order_components'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON item_compositions, item_composition_lines, production_orders, production_order_components FROM horizon_app, horizon_relay;
-- A version of a recipe is heard once and never revised; a newer one is another version.
GRANT SELECT, INSERT ON item_compositions, item_composition_lines TO horizon_app;
GRANT SELECT, INSERT ON production_orders TO horizon_app;
GRANT UPDATE ("status", "composition_version", "produced", "conversion_cost", "conversion_currency",
  "subcontractor_party_id", "released_at", "finished_at", "closure_reason", "updated_at")
  ON production_orders TO horizon_app;
GRANT SELECT, INSERT ON production_order_components TO horizon_app;
-- What the recipe asked for is frozen at release; what actually happened keeps changing
-- until the order is finished.
GRANT UPDATE ("issued", "issued_value", "scrapped", "scrapped_value", "currency")
  ON production_order_components TO horizon_app;
--> statement-breakpoint
-- The promise the whole document makes: everything issued became product or was ruined.
-- Checked when the order is settled, because until then it is simply incomplete.
CREATE FUNCTION assert_inventory_production_conserves() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  issued bigint;
  scrapped bigint;
BEGIN
  IF NEW.status <> 'finished' THEN RETURN NULL; END IF;
  SELECT coalesce(sum(c.issued_value), 0), coalesce(sum(c.scrapped_value), 0)
    INTO issued, scrapped
    FROM production_order_components c WHERE c.order_id = NEW.id;
  -- Nothing came out, so everything that went in has to be accounted for as ruined.
  IF NEW.produced = 0 AND issued <> scrapped THEN
    RAISE EXCEPTION 'order % produced nothing but only % of % was accounted for as ruined',
      NEW.id, scrapped, issued;
  END IF;
  IF scrapped > issued THEN
    RAISE EXCEPTION 'order % ruined % of the % it took', NEW.id, scrapped, issued;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER production_orders_conserve
  AFTER INSERT OR UPDATE ON production_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_inventory_production_conserves();
