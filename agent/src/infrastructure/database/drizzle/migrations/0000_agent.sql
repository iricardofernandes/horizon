-- The agent's own state (ADR 0065): whether a workspace lets agents in, and the audit of
-- every call. No business data lives here, and nothing here is read by another module.
CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Off until a workspace owner or admin turns it on; a tenant without a row is off.
CREATE TABLE "agent_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "tenants"("id"),
  "enabled" boolean NOT NULL,
  "updated_by" text NOT NULL CHECK (char_length("updated_by") BETWEEN 1 AND 128),
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "actor" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
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
CREATE INDEX "audit_log_tenant_actor_idx" ON "audit_log" ("tenant_id", "actor", "sequence");
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO horizon_app;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON tenants TO horizon_app USING (id = current_setting('app.current_tenant')::uuid) WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON agent_settings TO horizon_app USING (tenant_id = current_setting('app.current_tenant')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON audit_log TO horizon_app USING (tenant_id = current_setting('app.current_tenant')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, agent_settings, audit_log FROM horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON tenants TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON agent_settings TO horizon_app;
--> statement-breakpoint
GRANT UPDATE ("enabled", "updated_by", "updated_at") ON agent_settings TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO horizon_app;
--> statement-breakpoint
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_history_mutation();
