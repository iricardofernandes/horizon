-- The in-app assistant (Phase 76, ADR 0069): whether a workspace lets it generate, what it
-- spent, and each person's conversations, sealed under that person's key (ADR 0068).
CREATE TABLE "assistant_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "tenants"("id"),
  "enabled" boolean NOT NULL,
  "notice_version" text CHECK (char_length("notice_version") <= 64),
  "accepted_by" text CHECK (char_length("accepted_by") <= 128),
  "accepted_at" timestamp with time zone,
  "monthly_budget_tokens" integer NOT NULL CHECK ("monthly_budget_tokens" BETWEEN 1000 AND 50000000),
  "updated_by" text NOT NULL CHECK (char_length("updated_by") BETWEEN 1 AND 128),
  "updated_at" timestamp with time zone NOT NULL,
  -- On only with a notice someone accepted.
  CONSTRAINT "assistant_settings_notice" CHECK (NOT "enabled" OR ("notice_version" IS NOT NULL AND "accepted_by" IS NOT NULL AND "accepted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assistant_usage" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "month" date NOT NULL CHECK (extract(day FROM "month") = 1),
  "input_tokens" bigint DEFAULT 0 NOT NULL CHECK ("input_tokens" >= 0),
  "output_tokens" bigint DEFAULT 0 NOT NULL CHECK ("output_tokens" >= 0),
  "questions" integer DEFAULT 0 NOT NULL CHECK ("questions" >= 0),
  PRIMARY KEY ("tenant_id", "month")
);
--> statement-breakpoint
-- A person's key: destroying it makes every sealed turn of theirs unreadable.
CREATE TABLE "assistant_keys" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL,
  "wrapped_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "turns" integer DEFAULT 0 NOT NULL CHECK ("turns" >= 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "assistant_conversations_user_idx" ON "assistant_conversations" ("tenant_id", "user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "assistant_conversations_expiry_idx" ON "assistant_conversations" ("expires_at");
--> statement-breakpoint
CREATE TABLE "assistant_turns" (
  "tenant_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "ordinal" integer NOT NULL CHECK ("ordinal" >= 0),
  "sealed" bytea NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "conversation_id", "ordinal"),
  FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "assistant_conversations"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "inbox" (
  "source_module" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_module", "event_id")
);
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['assistant_settings','assistant_usage','assistant_keys','assistant_conversations','assistant_turns','inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON assistant_settings, assistant_usage, assistant_keys, assistant_conversations, assistant_turns, inbox FROM horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON assistant_settings TO horizon_app;
--> statement-breakpoint
GRANT UPDATE ("enabled", "notice_version", "accepted_by", "accepted_at", "monthly_budget_tokens", "updated_by", "updated_at") ON assistant_settings TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON assistant_usage TO horizon_app;
--> statement-breakpoint
GRANT UPDATE ("input_tokens", "output_tokens", "questions") ON assistant_usage TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON assistant_keys TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON assistant_conversations TO horizon_app;
--> statement-breakpoint
GRANT UPDATE ("turns", "updated_at", "expires_at") ON assistant_conversations TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON assistant_turns TO horizon_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON inbox TO horizon_app;
--> statement-breakpoint
-- Expired conversations across tenants (Phase 76): only rows already past their expiry are
-- visible to the migration role, and only to this function, which the application may run.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY purge_expired_read ON assistant_conversations FOR SELECT TO %I USING (expires_at <= now())', current_user);
  EXECUTE format('CREATE POLICY purge_expired ON assistant_conversations FOR DELETE TO %I USING (expires_at <= now())', current_user);
END $$;
--> statement-breakpoint
CREATE FUNCTION purge_expired_conversations() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE purged integer;
BEGIN
  DELETE FROM assistant_conversations WHERE expires_at <= now();
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_conversations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_conversations() TO horizon_app;
