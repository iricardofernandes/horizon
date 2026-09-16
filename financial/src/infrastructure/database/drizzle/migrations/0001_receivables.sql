CREATE TABLE "party_projection" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "party_id" uuid NOT NULL,
  -- Null once the party is erased: the projection destroys its copy, the titles stay.
  "legal_name" text,
  "roles" text[] NOT NULL DEFAULT '{}',
  "active" boolean NOT NULL,
  "erased" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "party_id"),
  CONSTRAINT "party_projection_erased_check" CHECK (NOT "erased" OR "legal_name" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "titles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "direction" text NOT NULL CHECK ("direction" IN ('receivable', 'payable')),
  "origin_type" text NOT NULL CHECK ("origin_type" IN ('manual', 'sales-order')),
  "origin_order_id" uuid,
  "party_id" uuid NOT NULL,
  "document_number" text NOT NULL CHECK (char_length("document_number") BETWEEN 1 AND 40),
  "description" text CHECK ("description" IS NULL OR char_length("description") <= 500),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "category_id" uuid,
  "issued_on" date NOT NULL,
  "competence_on" date NOT NULL,
  "allocations" jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("allocations") = 'array'),
  "status" text NOT NULL CHECK ("status" IN ('draft', 'posted', 'cancelled', 'reversed')),
  "settlement_state" text NOT NULL CHECK ("settlement_state" IN ('open', 'partially-settled', 'settled')),
  "total" bigint NOT NULL CHECK ("total" > 0),
  -- Derived by the aggregate and stored for filtering and aging; never below zero.
  "outstanding" bigint NOT NULL CHECK ("outstanding" >= 0),
  "next_due_on" date,
  "posted_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "closure_reason" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "titles_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "titles_category_fk" FOREIGN KEY ("tenant_id", "category_id")
    REFERENCES "financial_categories" ("tenant_id", "id"),
  CONSTRAINT "titles_origin_check" CHECK (("origin_type" = 'sales-order') = ("origin_order_id" IS NOT NULL)),
  CONSTRAINT "titles_posted_check" CHECK (("status" = 'draft' OR "status" = 'cancelled') = ("posted_at" IS NULL)),
  CONSTRAINT "titles_closure_check" CHECK (("status" IN ('cancelled', 'reversed')) = ("closed_at" IS NOT NULL AND "closure_reason" IS NOT NULL))
);
--> statement-breakpoint
-- One receivable per sales order, however often the confirmation is redelivered.
CREATE UNIQUE INDEX "titles_tenant_origin_order_key" ON "titles" ("tenant_id", "direction", "origin_order_id") WHERE "origin_order_id" IS NOT NULL;
CREATE INDEX "titles_tenant_listing_idx" ON "titles" ("tenant_id", "direction", "status", "issued_on" DESC);
CREATE INDEX "titles_tenant_party_idx" ON "titles" ("tenant_id", "party_id");
--> statement-breakpoint
CREATE TABLE "title_installments" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "title_id" uuid NOT NULL,
  "number" smallint NOT NULL CHECK ("number" BETWEEN 1 AND 120),
  "due_on" date NOT NULL,
  "amount" bigint NOT NULL CHECK ("amount" > 0),
  "outstanding" bigint NOT NULL CHECK ("outstanding" >= 0),
  "state" text NOT NULL CHECK ("state" IN ('open', 'partially-settled', 'settled')),
  PRIMARY KEY ("tenant_id", "title_id", "number"),
  CONSTRAINT "title_installments_title_fk" FOREIGN KEY ("tenant_id", "title_id")
    REFERENCES "titles" ("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "title_installments_due_idx" ON "title_installments" ("tenant_id", "due_on") WHERE "outstanding" > 0;
--> statement-breakpoint
CREATE TABLE "title_settlements" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "title_id" uuid NOT NULL,
  "installment_number" smallint NOT NULL,
  "settled_on" date NOT NULL,
  "received" bigint NOT NULL CHECK ("received" >= 0),
  "discount" bigint NOT NULL CHECK ("discount" >= 0),
  "interest" bigint NOT NULL CHECK ("interest" >= 0),
  "penalty" bigint NOT NULL CHECK ("penalty" >= 0),
  "payment_method_id" uuid,
  "recorded_at" timestamp with time zone NOT NULL,
  "reversed_at" timestamp with time zone,
  "reversal_reason" text,
  CONSTRAINT "title_settlements_installment_fk" FOREIGN KEY ("tenant_id", "title_id", "installment_number")
    REFERENCES "title_installments" ("tenant_id", "title_id", "number"),
  CONSTRAINT "title_settlements_reversal_check" CHECK (("reversed_at" IS NULL) = ("reversal_reason" IS NULL)),
  CONSTRAINT "title_settlements_nonempty_check" CHECK ("received" + "discount" > 0)
);
--> statement-breakpoint
CREATE INDEX "title_settlements_title_idx" ON "title_settlements" ("tenant_id", "title_id", "recorded_at");
--> statement-breakpoint
-- Replay protection for money-moving commands (ADR 0028). Stored in the same transaction as
-- the effect, so a response is recorded exactly when the change it describes is.
CREATE TABLE "command_receipts" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 8 AND 255),
  "command" text NOT NULL,
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "actor" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "action" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "request_id" text,
  "trace_id" text,
  "details" jsonb NOT NULL,
  "previous_hash" text NOT NULL,
  "hash" text NOT NULL,
  CONSTRAINT "audit_log_tenant_sequence_key" UNIQUE ("tenant_id", "sequence")
);
--> statement-breakpoint
CREATE INDEX "audit_log_tenant_subject_idx" ON "audit_log" ("tenant_id", "subject_type", "subject_id", "sequence");
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "event_id" uuid NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "event_version" smallint NOT NULL CHECK (event_version > 0),
  "occurred_at" timestamptz NOT NULL,
  "trace_id" text NOT NULL,
  "trace_parent" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "dispatched_at" timestamptz,
  "attempts" smallint DEFAULT 0 NOT NULL CHECK (attempts >= 0),
  "last_error" text
);
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_source_event_key" UNIQUE("source_module", "event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" ("created_at") WHERE dispatched_at IS NULL;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO horizon_relay;
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['party_projection','titles','title_installments','title_settlements','command_receipts','audit_log','outbox','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON party_projection, titles, title_installments, title_settlements, command_receipts, audit_log, outbox, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON party_projection, titles TO horizon_app;
-- A draft's schedule is replaced wholesale; a posted schedule only has its balances refreshed.
GRANT SELECT, INSERT, DELETE ON title_installments TO horizon_app;
GRANT UPDATE ("outstanding", "state") ON title_installments TO horizon_app;
-- A settlement is never edited or deleted: the only change it accepts is being reversed.
GRANT SELECT, INSERT ON title_settlements TO horizon_app;
GRANT UPDATE ("reversed_at", "reversal_reason") ON title_settlements TO horizon_app;
GRANT SELECT, INSERT ON audit_log, inbox TO horizon_app;
-- A receipt is claimed before the command runs and filled in with its response after.
GRANT SELECT, INSERT ON command_receipts TO horizon_app;
GRANT UPDATE ("response") ON command_receipts TO horizon_app;
GRANT INSERT ON outbox TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_posted_schedule_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM titles WHERE tenant_id = OLD.tenant_id AND id = OLD.title_id AND status <> 'draft') THEN
    RAISE EXCEPTION 'the schedule of a posted title cannot be removed';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER title_installments_draft_only BEFORE DELETE ON title_installments
  FOR EACH ROW EXECUTE FUNCTION reject_posted_schedule_change();
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION stamp_financial_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN RAISE EXCEPTION 'outbox tenant does not match transaction'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION stamp_financial_outbox_tenant();
