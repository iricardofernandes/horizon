-- Phase 52: contract periods are billed once, each frozen as it was billed, and billing
-- runs record what they did to every contract of a competence month (ADR 0056).
CREATE TABLE "contract_billed_periods" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "contract_id" uuid NOT NULL,
  "competence" text NOT NULL CHECK ("competence" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  "revision" integer NOT NULL,
  "starts_on" date NOT NULL CHECK (extract(day FROM "starts_on") = 1),
  "ends_on" date NOT NULL CHECK ("ends_on" > "starts_on"),
  "issued_on" date NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "value" bigint NOT NULL CHECK ("value" > 0),
  "installments" jsonb NOT NULL,
  "run_id" uuid,
  "billed_by" text NOT NULL,
  "billed_at" timestamptz NOT NULL,
  "credit_reason_code" text CHECK ("credit_reason_code" IN ('not-provided', 'billing-error')),
  "credit_reason" text,
  "credited_on" date,
  "credited_by" text,
  "credited_at" timestamptz,
  -- Effects followed from their owners' events; not facts of the period.
  "receivable_title_id" uuid,
  "receivable_posted_at" timestamptz,
  "receivable_reversed_at" timestamptz,
  CONSTRAINT "contract_billed_periods_tenant_id_key" UNIQUE ("tenant_id", "id"),
  -- A contract bills each competence month once (ADR 0056, decision 3).
  CONSTRAINT "contract_billed_periods_once" UNIQUE ("tenant_id", "contract_id", "competence"),
  CONSTRAINT "contract_billed_periods_revision_fk" FOREIGN KEY ("tenant_id", "contract_id", "revision")
    REFERENCES "service_contract_revisions" ("tenant_id", "contract_id", "revision"),
  CONSTRAINT "contract_billed_periods_month_check" CHECK (
    to_char("starts_on", 'YYYY-MM') = "competence"
  ),
  CONSTRAINT "contract_billed_periods_credit_check" CHECK (
    ("credit_reason_code" IS NULL) = ("credit_reason" IS NULL)
    AND ("credit_reason_code" IS NULL) = ("credited_on" IS NULL)
    AND ("credit_reason_code" IS NULL) = ("credited_by" IS NULL)
    AND ("credit_reason_code" IS NULL) = ("credited_at" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "contract_billed_periods_contract_idx"
  ON "contract_billed_periods" ("tenant_id", "contract_id", "starts_on");
CREATE INDEX "contract_billed_periods_title_idx"
  ON "contract_billed_periods" ("tenant_id", "receivable_title_id");
--> statement-breakpoint
CREATE TABLE "contract_billed_period_lines" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "entry_id" uuid NOT NULL,
  "billed_period_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" bigint NOT NULL CHECK ("quantity" > 0),
  "unit_price" bigint NOT NULL CHECK ("unit_price" >= 0),
  "amount" bigint NOT NULL CHECK ("amount" >= 0),
  "position" smallint NOT NULL CHECK ("position" >= 0),
  -- The NFS-e outcome followed from Fiscal; not a fact of the line.
  "nfse_document_id" uuid,
  "nfse_status" text CHECK ("nfse_status" IN ('authorized', 'rejected', 'cancelled')),
  "nfse_observed_at" timestamptz,
  PRIMARY KEY ("tenant_id", "entry_id"),
  CONSTRAINT "contract_billed_period_lines_period_fk" FOREIGN KEY ("tenant_id", "billed_period_id")
    REFERENCES "contract_billed_periods" ("tenant_id", "id")
);
CREATE INDEX "contract_billed_period_lines_period_idx"
  ON "contract_billed_period_lines" ("tenant_id", "billed_period_id", "position");
--> statement-breakpoint
CREATE TABLE "contract_billing_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "competence" text NOT NULL CHECK ("competence" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  "status" text NOT NULL CHECK ("status" IN ('running', 'completed')),
  "requested_by" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  CONSTRAINT "contract_billing_runs_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "contract_billing_runs_finish_check" CHECK (
    ("status" = 'completed') = ("finished_at" IS NOT NULL)
  )
);
CREATE INDEX "contract_billing_runs_competence_idx"
  ON "contract_billing_runs" ("tenant_id", "competence", "started_at");
--> statement-breakpoint
CREATE TABLE "contract_billing_run_items" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "run_id" uuid NOT NULL,
  "contract_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('pending', 'billed', 'skipped', 'refused')),
  "reason" text,
  "billed_period_id" uuid,
  "decided_at" timestamptz,
  PRIMARY KEY ("tenant_id", "run_id", "contract_id"),
  CONSTRAINT "contract_billing_run_items_run_fk" FOREIGN KEY ("tenant_id", "run_id")
    REFERENCES "contract_billing_runs" ("tenant_id", "id"),
  CONSTRAINT "contract_billing_run_items_contract_fk" FOREIGN KEY ("tenant_id", "contract_id")
    REFERENCES "service_contracts" ("tenant_id", "id"),
  CONSTRAINT "contract_billing_run_items_decision_check" CHECK (
    ("outcome" = 'pending') = ("decided_at" IS NULL)
    AND ("outcome" = 'billed') = ("billed_period_id" IS NOT NULL)
    AND ("outcome" IN ('pending', 'billed')) = ("reason" IS NULL)
  )
);
CREATE INDEX "contract_billing_run_items_pending_idx"
  ON "contract_billing_run_items" ("tenant_id", "run_id") WHERE "outcome" = 'pending';
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contract_billed_periods', 'contract_billed_period_lines', 'contract_billing_runs',
    'contract_billing_run_items'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON contract_billed_periods, contract_billed_period_lines, contract_billing_runs,
  contract_billing_run_items FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON contract_billed_periods, contract_billed_period_lines,
  contract_billing_runs, contract_billing_run_items TO horizon_app;
-- The billing gauges count across tenants through the relay connection. They see only
-- what counting needs: no tenant, contract, customer or amount (ADR 0055).
GRANT SELECT ("id", "billed_at", "credit_reason_code", "receivable_posted_at")
  ON contract_billed_periods TO horizon_relay;
GRANT SELECT ("billed_period_id", "nfse_status") ON contract_billed_period_lines TO horizon_relay;
CREATE POLICY relay_billing_gauges ON contract_billed_periods FOR SELECT TO horizon_relay
  USING (true);
CREATE POLICY relay_billing_gauges ON contract_billed_period_lines FOR SELECT TO horizon_relay
  USING (true);
--> statement-breakpoint
-- A billed period never changes what it billed. Its credit is written once, and the
-- receivable it raised is the only other thing recorded on it.
CREATE FUNCTION reject_billed_period_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.contract_id, NEW.competence, NEW.revision, NEW.starts_on,
      NEW.ends_on, NEW.issued_on, NEW.currency, NEW.value, NEW.installments, NEW.run_id,
      NEW.billed_by, NEW.billed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.contract_id, OLD.competence, OLD.revision, OLD.starts_on,
      OLD.ends_on, OLD.issued_on, OLD.currency, OLD.value, OLD.installments, OLD.run_id,
      OLD.billed_by, OLD.billed_at) THEN
    RAISE EXCEPTION 'a billed period never changes what it billed' USING ERRCODE = '23514';
  END IF;
  IF OLD.credit_reason_code IS NOT NULL AND
     (NEW.credit_reason_code, NEW.credit_reason, NEW.credited_on, NEW.credited_by, NEW.credited_at)
     IS DISTINCT FROM
     (OLD.credit_reason_code, OLD.credit_reason, OLD.credited_on, OLD.credited_by, OLD.credited_at) THEN
    RAISE EXCEPTION 'a credit is never rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_billed_periods_frozen BEFORE UPDATE ON contract_billed_periods
  FOR EACH ROW EXECUTE FUNCTION reject_billed_period_rewrite();
--> statement-breakpoint
CREATE FUNCTION reject_billed_line_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.entry_id, NEW.billed_period_id, NEW.line_id, NEW.item_id,
      NEW.description, NEW.quantity, NEW.unit_price, NEW.amount, NEW.position)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.entry_id, OLD.billed_period_id, OLD.line_id, OLD.item_id,
      OLD.description, OLD.quantity, OLD.unit_price, OLD.amount, OLD.position) THEN
    RAISE EXCEPTION 'a billed line never changes what it billed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_billed_period_lines_frozen BEFORE UPDATE ON contract_billed_period_lines
  FOR EACH ROW EXECUTE FUNCTION reject_billed_line_rewrite();
--> statement-breakpoint
-- A run item is decided once; a decision is what the run did.
CREATE FUNCTION reject_run_item_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome <> 'pending' OR (NEW.tenant_id, NEW.run_id, NEW.contract_id, NEW.customer_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.run_id, OLD.contract_id, OLD.customer_id) THEN
    RAISE EXCEPTION 'a billing run item is decided once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_billing_run_items_forward BEFORE UPDATE ON contract_billing_run_items
  FOR EACH ROW EXECUTE FUNCTION reject_run_item_rewrite();
