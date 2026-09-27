-- Phase 51: services sold for a recurring fee (ADR 0056). What a contract bills lives in
-- insert-only revisions, each in force from a period start, so a period that has begun
-- never changes what it bills.
CREATE TABLE "service_contracts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "customer_id" uuid NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "starts_on" date NOT NULL CHECK (extract(day FROM "starts_on") = 1),
  "ends_on" date CHECK ("ends_on" > "starts_on"),
  "billing_day" smallint NOT NULL CHECK ("billing_day" BETWEEN 1 AND 28),
  "auto_renew" boolean NOT NULL,
  "term_months" integer CHECK ("term_months" > 0),
  "payment_term_days" jsonb NOT NULL,
  "seller_id" uuid,
  "notes" text,
  "stage" text NOT NULL CHECK ("stage" IN ('draft', 'active', 'discarded')),
  "cancelled_from" date,
  "cancellation_reason" text,
  "cancelled_by" text,
  "cancelled_at" timestamptz,
  "created_by" text NOT NULL,
  "activated_at" timestamptz,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "service_contracts_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "service_contracts_customer_fk" FOREIGN KEY ("tenant_id", "customer_id")
    REFERENCES "customers" ("tenant_id", "id"),
  CONSTRAINT "service_contracts_renewal_check" CHECK (NOT "auto_renew" OR "ends_on" IS NOT NULL),
  CONSTRAINT "service_contracts_term_check" CHECK (("ends_on" IS NULL) = ("term_months" IS NULL)),
  CONSTRAINT "service_contracts_cancellation_check" CHECK (
    ("cancelled_from" IS NULL) = ("cancellation_reason" IS NULL)
    AND ("cancelled_from" IS NULL) = ("cancelled_by" IS NULL)
    AND ("cancelled_from" IS NULL) = ("cancelled_at" IS NULL)
  ),
  CONSTRAINT "service_contracts_activation_check" CHECK (
    ("stage" = 'draft') = ("activated_at" IS NULL) OR "stage" = 'discarded'
  )
);
--> statement-breakpoint
CREATE INDEX "service_contracts_customer_idx" ON "service_contracts" ("tenant_id", "customer_id", "created_at");
CREATE INDEX "service_contracts_renewal_idx" ON "service_contracts" ("tenant_id", "ends_on")
  WHERE "stage" = 'active' AND "auto_renew";
--> statement-breakpoint
CREATE TABLE "service_contract_revisions" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "contract_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "kind" text NOT NULL CHECK ("kind" IN ('initial', 'amendment', 'renewal')),
  "effective_from" date NOT NULL CHECK (extract(day FROM "effective_from") = 1),
  "recurrence" text NOT NULL CHECK ("recurrence" IN ('monthly', 'quarterly', 'yearly')),
  "readjustment_basis_points" integer CHECK ("readjustment_basis_points" BETWEEN -10000 AND 100000),
  "reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "contract_id", "revision"),
  CONSTRAINT "service_contract_revisions_contract_fk" FOREIGN KEY ("tenant_id", "contract_id")
    REFERENCES "service_contracts" ("tenant_id", "id"),
  CONSTRAINT "service_contract_revisions_reason_check" CHECK (
    "kind" <> 'amendment' OR "reason" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE TABLE "service_contract_revision_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "contract_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "position" smallint NOT NULL CHECK ("position" >= 0),
  PRIMARY KEY ("tenant_id", "contract_id", "revision", "line_id"),
  CONSTRAINT "service_contract_revision_lines_revision_fk"
    FOREIGN KEY ("tenant_id", "contract_id", "revision")
    REFERENCES "service_contract_revisions" ("tenant_id", "contract_id", "revision")
);
--> statement-breakpoint
CREATE TABLE "service_contract_suspensions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "contract_id" uuid NOT NULL,
  "from_date" date NOT NULL,
  "until_date" date CHECK ("until_date" > "from_date"),
  "reason" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "service_contract_suspensions_contract_fk" FOREIGN KEY ("tenant_id", "contract_id")
    REFERENCES "service_contracts" ("tenant_id", "id")
);
CREATE INDEX "service_contract_suspensions_contract_idx"
  ON "service_contract_suspensions" ("tenant_id", "contract_id", "from_date");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'service_contracts', 'service_contract_revisions', 'service_contract_revision_lines',
    'service_contract_suspensions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON service_contracts, service_contract_revisions, service_contract_revision_lines,
  service_contract_suspensions FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON service_contracts TO horizon_app;
-- Revisions and their lines are insert-only: a revision is what some period billed.
GRANT SELECT, INSERT ON service_contract_revisions, service_contract_revision_lines TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON service_contract_suspensions TO horizon_app;
--> statement-breakpoint
-- A suspension only ever gains its resumption date, once.
CREATE FUNCTION reject_contract_suspension_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.contract_id, NEW.from_date, NEW.reason, NEW.created_by,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.contract_id, OLD.from_date, OLD.reason, OLD.created_by,
      OLD.created_at)
     OR OLD.until_date IS NOT NULL THEN
    RAISE EXCEPTION 'a contract suspension only gains its resumption, once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_contract_suspensions_forward BEFORE UPDATE ON service_contract_suspensions
  FOR EACH ROW EXECUTE FUNCTION reject_contract_suspension_rewrite();
--> statement-breakpoint
-- A cancellation, once written, is never moved or withdrawn.
CREATE FUNCTION reject_contract_cancellation_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_from IS NOT NULL AND (NEW.cancelled_from, NEW.cancellation_reason)
     IS DISTINCT FROM (OLD.cancelled_from, OLD.cancellation_reason) THEN
    RAISE EXCEPTION 'a contract cancellation is never rewritten' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.customer_id, NEW.currency, NEW.starts_on, NEW.billing_day)
     IS DISTINCT FROM (OLD.tenant_id, OLD.customer_id, OLD.currency, OLD.starts_on, OLD.billing_day) THEN
    RAISE EXCEPTION 'a contract keeps its customer, currency, start and billing day'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_contracts_forward BEFORE UPDATE ON service_contracts
  FOR EACH ROW EXECUTE FUNCTION reject_contract_cancellation_rewrite();
