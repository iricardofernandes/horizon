-- The issuer address and item-to-NF-e mappings are reviewed separately from
-- the historical owner projections and cannot change for a capability.
CREATE TABLE fiscal_homologation_issuance_profiles (
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_id),
  FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id)
);

CREATE FUNCTION verify_fiscal_homologation_issuance_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP'
    OR definition.operation <> 'normal-sale'
    OR definition.source_manifest_digest <> NEW.source_manifest_digest
    OR definition.created_by = NEW.reviewed_by
    OR (NEW.profile->>'capabilityId') IS DISTINCT FROM NEW.capability_id::text
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation issuance profile differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_issuance_profile_valid
  BEFORE INSERT ON fiscal_homologation_issuance_profiles
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_issuance_profile();

ALTER TABLE fiscal_homologation_issuance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_issuance_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_issuance_profiles TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_issuance_profiles TO horizon_app;
CREATE TRIGGER fiscal_homologation_issuance_profiles_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_issuance_profiles FOR EACH ROW
  EXECUTE FUNCTION reject_fiscal_immutable_mutation();
