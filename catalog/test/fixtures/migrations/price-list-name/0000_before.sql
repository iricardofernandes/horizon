CREATE TEMPORARY TABLE migration_price_lists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT migration_price_lists_tenant_name_key UNIQUE (tenant_id, name)
);
--> statement-breakpoint
INSERT INTO migration_price_lists (id, tenant_id, name) VALUES
  ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000010', 'Legacy'),
  ('00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000010', 'Touched legacy');
