-- A digest alone is not source evidence. The exact event archive must have
-- retained bytes and an independent package review before capability approval.
CREATE OR REPLACE FUNCTION verify_fiscal_homologation_event_schema_approval()
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
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_capability_reviews review
      WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
        AND review.approved AND review.reviewed_by = NEW.reviewed_by
    ) THEN
    RAISE EXCEPTION 'Homologation event schema differs from reviewed capability'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_source_packages package
    JOIN fiscal_source_payloads payload
      ON payload.tenant_id = package.tenant_id AND payload.package_id = package.id
    JOIN fiscal_package_reviews review
      ON review.tenant_id = package.tenant_id AND review.package_id = package.id
    WHERE package.tenant_id = NEW.tenant_id
      AND package.package_digest = NEW.schema_digest
      AND payload.byte_size = octet_length(payload.source_bytes)
      AND review.approved AND review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'Homologation event schema lacks retained reviewed bytes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
