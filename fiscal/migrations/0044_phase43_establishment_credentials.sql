-- Each A1 certificate belongs to one tenant and establishment. Historical versions
-- remain available for consultations of exchanges bound to their fingerprint.
CREATE TABLE fiscal_establishment_credentials (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  establishment_id uuid NOT NULL,
  issuer_tax_id text NOT NULL CHECK (issuer_tax_id ~ '^[0-9A-Z]{14}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  valid_until timestamptz NOT NULL,
  encrypted_pem bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  uploaded_by text NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 200),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_establishment_credential_unique UNIQUE (tenant_id, establishment_id, fingerprint)
);
CREATE UNIQUE INDEX fiscal_establishment_credential_active
  ON fiscal_establishment_credentials (tenant_id, establishment_id) WHERE active;
CREATE INDEX fiscal_establishment_credential_fingerprint
  ON fiscal_establishment_credentials (tenant_id, fingerprint);
ALTER TABLE fiscal_establishment_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_establishment_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_establishment_credentials TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
REVOKE ALL ON fiscal_establishment_credentials FROM horizon_app;
GRANT SELECT, INSERT, UPDATE (active) ON fiscal_establishment_credentials TO horizon_app;
