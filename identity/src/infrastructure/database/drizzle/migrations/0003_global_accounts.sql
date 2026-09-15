CREATE TABLE "account_directory" (
	"email_index" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "account_directory_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "account_memberships" (
	"account_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_slug" text NOT NULL,
	"workspace_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_memberships_account_id_tenant_id_pk" PRIMARY KEY("account_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "account_directory" ADD CONSTRAINT "account_directory_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_memberships_tenant_user_key" ON "account_memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "account_memberships_account_idx" ON "account_memberships" USING btree ("account_id","workspace_name");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_tenant_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON accounts TO horizon_app
  USING (id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (id = current_setting('app.current_account', true)::uuid);
--> statement-breakpoint
ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON account_memberships TO horizon_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);
--> statement-breakpoint
ALTER TABLE account_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY account_directory_read ON account_directory FOR SELECT TO horizon_app USING (true);
CREATE POLICY account_directory_register ON account_directory FOR INSERT TO horizon_app
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON accounts, account_memberships TO horizon_app;
GRANT SELECT, INSERT ON account_directory TO horizon_app;
