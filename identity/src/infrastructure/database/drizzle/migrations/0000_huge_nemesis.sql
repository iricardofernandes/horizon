CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issued_by" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text,
	"trace_id" text,
	"source_ip" text,
	"before" jsonb,
	"after" jsonb,
	"redacted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_subject_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"material" text,
	"created_at" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"source_module" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" smallint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"trace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "tenant_directory" (
	"slug" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "tenant_directory_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email_ciphertext" text NOT NULL,
	"email_index" text NOT NULL,
	"name_ciphertext" text NOT NULL,
	"password_hash" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_keyset_idx" ON "api_keys" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_issuer_idx" ON "api_keys" USING btree ("tenant_id","issued_by");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_tenant_sequence_key" ON "audit_log" USING btree ("tenant_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_subject_idx" ON "audit_log" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_source_event_key" ON "inbox" USING btree ("source_module","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" USING btree ("created_at") WHERE dispatched_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_index_key" ON "users" USING btree ("tenant_id","email_index");--> statement-breakpoint
CREATE INDEX "users_tenant_keyset_idx" ON "users" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "users_tenant_status_idx" ON "users" USING btree ("tenant_id","status") WHERE status = 'active';