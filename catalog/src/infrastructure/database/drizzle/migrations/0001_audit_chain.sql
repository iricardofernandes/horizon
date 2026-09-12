-- The audit table shipped with 0000 without the columns a hash chain needs to be
-- verifiable by someone who does not trust the operators (ADR 0025): who acted and in
-- what capacity, from where, and which members were removed before hashing.
--
-- Purely additive, and safe to apply while the service runs: nothing has ever written to
-- this table, so there is no backfill and the NOT NULL columns can take their defaults.
-- A migration that reshapes a table holding rows is a different exercise — see
-- docs/patterns/zero-downtime-migration.md.
ALTER TABLE audit_log ADD COLUMN "id" uuid;
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN "actor_type" text NOT NULL DEFAULT 'system'
  CHECK (actor_type IN ('user','api-key','system'));
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN "source_ip" text;
--> statement-breakpoint
-- Inside the hashed payload, so declaring a field sensitive after the fact breaks the
-- chain exactly as changing the data does.
ALTER TABLE audit_log ADD COLUMN "redacted" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- The default exists only so the ALTER is instant on an empty table; every row the
-- application writes states its actor explicitly.
ALTER TABLE audit_log ALTER COLUMN "actor_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE audit_log ALTER COLUMN "id" SET NOT NULL;
CREATE UNIQUE INDEX "audit_log_id_key" ON audit_log ("id");
CREATE INDEX "audit_log_tenant_subject_idx" ON audit_log ("tenant_id","subject_type","subject_id");
