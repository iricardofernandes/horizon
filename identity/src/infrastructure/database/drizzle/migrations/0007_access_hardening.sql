-- Second factors of a global account (ADR 0061 §2). TOTP secrets are sealed; a passkey
-- keeps only its public key. Removal keeps the row, so the audit trail can name it.
CREATE TABLE "account_factors" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('totp', 'passkey')),
  "label" text NOT NULL CHECK (char_length("label") BETWEEN 1 AND 60),
  "secret_sealed" text,
  "credential_id" text,
  "public_key" text,
  "sign_count" bigint DEFAULT 0 NOT NULL CHECK ("sign_count" >= 0),
  "transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "confirmed_at" timestamp with time zone,
  "last_used_step" bigint,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "removed_at" timestamp with time zone,
  CONSTRAINT "account_factors_material" CHECK (
    ("kind" = 'totp' AND "secret_sealed" IS NOT NULL)
    OR ("kind" = 'passkey' AND "credential_id" IS NOT NULL AND "public_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "account_factors_account_idx" ON "account_factors" ("account_id") WHERE "removed_at" IS NULL;
CREATE UNIQUE INDEX "account_factors_credential_key" ON "account_factors" ("credential_id") WHERE "credential_id" IS NOT NULL;
--> statement-breakpoint
-- Ten codes per account, kept only as keyed digests, each used once.
CREATE TABLE "account_recovery_codes" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "code_digest" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  PRIMARY KEY ("account_id", "code_digest")
);
--> statement-breakpoint
-- Invitations to a workspace (ADR 0061 §1). Only the link's digest is kept, and the email
-- only while pending.
CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "email" text,
  "masked_email" text NOT NULL,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200),
  "roles" jsonb NOT NULL CHECK (jsonb_typeof("roles") = 'array'),
  "token_digest" text NOT NULL UNIQUE,
  "status" text NOT NULL CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
  "invited_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "sends" integer DEFAULT 1 NOT NULL CHECK ("sends" >= 1),
  "accepted_user_id" uuid,
  "ended_at" timestamp with time zone,
  CONSTRAINT "invitations_email_while_pending" CHECK ("status" = 'pending' OR "email" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "invitations_tenant_idx" ON "invitations" ("tenant_id", "created_at");
--> statement-breakpoint
-- The only cross-tenant lookup: a link's digest to its workspace, nothing else.
CREATE TABLE "invitation_directory" (
  "token_digest" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "invitation_id" uuid NOT NULL UNIQUE
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mfa_policy" text DEFAULT 'off' NOT NULL CHECK ("mfa_policy" IN ('off', 'admins', 'everyone'));
ALTER TABLE "tenants" ADD COLUMN "mfa_grace_days" integer DEFAULT 0 NOT NULL CHECK ("mfa_grace_days" BETWEEN 0 AND 30);
ALTER TABLE "tenants" ADD COLUMN "mfa_policy_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE account_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON account_factors TO horizon_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);
ALTER TABLE account_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON account_recovery_codes TO horizon_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON invitations TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
ALTER TABLE invitation_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_read ON invitation_directory FOR SELECT TO horizon_app USING (true);
CREATE POLICY directory_write ON invitation_directory TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON account_factors, account_recovery_codes, invitations TO horizon_app;
GRANT DELETE ON account_recovery_codes TO horizon_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON invitation_directory TO horizon_app;
