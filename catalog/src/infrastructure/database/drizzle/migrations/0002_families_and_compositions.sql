-- A catalogue that can only list things says nothing about how they relate. These forty
-- shirts are one shirt in forty combinations; that chair is a seat, a back and four legs.
-- Both are facts about the goods rather than about any one document, so they belong here
-- rather than being rediscovered by every module that needs them.
CREATE TABLE "product_families" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 160),
  -- Ordered, and fixed once anything is in the family: gaining an axis would leave every
  -- variant unable to answer, and losing one would make two that used to differ the same.
  "attributes" text[] NOT NULL CHECK (
    cardinality("attributes") BETWEEN 1 AND 8
  ),
  "active" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "product_families_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "product_families_tenant_name_key" UNIQUE ("tenant_id", "name")
);
--> statement-breakpoint
CREATE INDEX "product_families_tenant_keyset_idx" ON "product_families" ("tenant_id", "created_at", "id");
--> statement-breakpoint
-- One item's place in a family. The item keeps its own SKU, its own stock and its own
-- price — a variant is a product in its own right, and the family only says what makes it
-- different from its siblings.
CREATE TABLE "item_variants" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "item_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  -- The answers in the family's own order, case-folded. Two variants with the same one
  -- are the same variant, which is the whole point of varying along axes.
  "combination" text NOT NULL CHECK (char_length("combination") BETWEEN 1 AND 2000),
  "values" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "item_id"),
  CONSTRAINT "item_variants_family_combination_key" UNIQUE ("tenant_id", "family_id", "combination"),
  CONSTRAINT "item_variants_tenant_item_fk" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "catalog_items"("tenant_id", "id"),
  CONSTRAINT "item_variants_tenant_family_fk" FOREIGN KEY ("tenant_id", "family_id") REFERENCES "product_families"("tenant_id", "id")
);
--> statement-breakpoint
-- What an item is made of, from a date. Versioned rather than edited: a production order
-- that consumed four of something is not wrong because the recipe now says three.
CREATE TABLE "compositions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "parent_item_id" uuid NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  -- `assembled` is a recipe: the parent is stocked and something makes it. `exploded` is
  -- a bundle: the parent is never stocked and stands for what is underneath it.
  "realisation" text NOT NULL CHECK ("realisation" IN ('assembled', 'exploded')),
  "effective_from" date NOT NULL,
  "defined_by" text NOT NULL,
  "defined_at" timestamptz NOT NULL,
  CONSTRAINT "compositions_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "compositions_parent_version_key" UNIQUE ("tenant_id", "parent_item_id", "version"),
  CONSTRAINT "compositions_tenant_parent_fk" FOREIGN KEY ("tenant_id", "parent_item_id") REFERENCES "catalog_items"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "compositions_parent_effective_idx" ON "compositions" ("tenant_id", "parent_item_id", "effective_from");
--> statement-breakpoint
CREATE TABLE "composition_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "composition_id" uuid NOT NULL,
  "component_item_id" uuid NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  PRIMARY KEY ("tenant_id", "composition_id", "component_item_id"),
  CONSTRAINT "composition_lines_composition_fk" FOREIGN KEY ("tenant_id", "composition_id") REFERENCES "compositions"("tenant_id", "id"),
  CONSTRAINT "composition_lines_tenant_component_fk" FOREIGN KEY ("tenant_id", "component_item_id") REFERENCES "catalog_items"("tenant_id", "id")
);
--> statement-breakpoint
-- Reading the graph downwards is how an explosion is computed, so the component side
-- needs an index of its own: "what is this part used in" is asked as often as "what is
-- this made of".
CREATE INDEX "composition_lines_component_idx" ON "composition_lines" ("tenant_id", "component_item_id");
--> statement-breakpoint
-- An item is not made of itself, at any distance. The aggregate refuses the one-step
-- case and the use case walks the graph before writing; this is the guard that holds when
-- two people define halves of a cycle at the same moment and neither walk saw the other.
CREATE FUNCTION reject_catalog_composition_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent uuid;
BEGIN
  SELECT c.parent_item_id INTO parent FROM compositions c WHERE c.id = NEW.composition_id;
  IF parent IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    WITH RECURSIVE below(item_id, depth) AS (
      SELECT NEW.component_item_id, 1
      UNION ALL
      SELECT l.component_item_id, b.depth + 1
      FROM below b
      JOIN compositions c ON c.parent_item_id = b.item_id
      JOIN composition_lines l ON l.composition_id = c.id
      WHERE b.depth < 32
    )
    SELECT 1 FROM below WHERE item_id = parent
  ) THEN
    RAISE EXCEPTION 'component % is made of %, which would make an item part of itself',
      NEW.component_item_id, parent;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Deferred, because the lines of one composition are written one statement at a time and
-- are only a graph once the command is done.
CREATE CONSTRAINT TRIGGER composition_lines_acyclic
  AFTER INSERT ON composition_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reject_catalog_composition_cycle();
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['product_families','item_variants','compositions','composition_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON product_families, item_variants, compositions, composition_lines FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON product_families, item_variants TO horizon_app;
-- A published version of a recipe is never rewritten; superseding it is another version.
GRANT SELECT, INSERT ON compositions, composition_lines TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_catalog_composition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'a published composition is superseded, never rewritten'; END $$;
CREATE TRIGGER compositions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON compositions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_catalog_composition_mutation();
CREATE TRIGGER composition_lines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON composition_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_catalog_composition_mutation();
