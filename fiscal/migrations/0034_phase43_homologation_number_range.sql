-- The reviewed issuer range, not a process default, determines the first live
-- homologation number. A tuple has one immutable range in this phase.
CREATE TABLE fiscal_homologation_number_ranges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  establishment_id uuid NOT NULL,
  series integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  first_number bigint NOT NULL CHECK (first_number BETWEEN 1 AND 999999999),
  last_number bigint NOT NULL CHECK (last_number BETWEEN 1 AND 999999999),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_number <= last_number),
  CONSTRAINT fiscal_homologation_number_range_capability_fk
    FOREIGN KEY (tenant_id, capability_id)
    REFERENCES fiscal_capability_definitions(tenant_id, id),
  CONSTRAINT fiscal_homologation_number_range_tuple
    UNIQUE (tenant_id, establishment_id, series)
);

CREATE FUNCTION verify_fiscal_homologation_number_range()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition fiscal_capability_definitions%ROWTYPE;
BEGIN
  SELECT * INTO definition FROM fiscal_capability_definitions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.capability_id;
  IF definition.environment <> 'homologation' OR definition.model <> '55'
    OR definition.jurisdiction_kind <> 'uf' OR definition.jurisdiction_code <> 'SP'
    OR definition.operation <> 'normal-sale'
    OR definition.establishment_id <> NEW.establishment_id THEN
    RAISE EXCEPTION 'Homologation number range differs from reviewed tuple'
      USING ERRCODE = '23514';
  END IF;
  IF definition.created_by = NEW.reviewed_by OR NOT EXISTS (
    SELECT 1 FROM fiscal_capability_reviews review
    WHERE review.tenant_id = NEW.tenant_id AND review.capability_id = NEW.capability_id
      AND review.approved AND review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'Homologation number range requires independent capability reviewer'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_homologation_number_ranges existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.establishment_id = NEW.establishment_id
      AND existing.series = NEW.series
  ) AND EXISTS (
    SELECT 1 FROM fiscal_number_counters counter
    WHERE counter.tenant_id = NEW.tenant_id
      AND counter.establishment_id = NEW.establishment_id
      AND counter.environment = 'homologation' AND counter.model = '55'
      AND counter.series = NEW.series
  ) THEN
    RAISE EXCEPTION 'Homologation number counter exists before reviewed range'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_number_range_valid
  BEFORE INSERT ON fiscal_homologation_number_ranges
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_number_range();

ALTER TABLE fiscal_homologation_number_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_homologation_number_ranges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_homologation_number_ranges TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_homologation_number_ranges TO horizon_app;
CREATE TRIGGER fiscal_homologation_number_ranges_immutable BEFORE UPDATE OR DELETE
  ON fiscal_homologation_number_ranges FOR EACH ROW
  EXECUTE FUNCTION reject_fiscal_immutable_mutation();

CREATE FUNCTION verify_fiscal_homologation_number_counter()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE range_row fiscal_homologation_number_ranges%ROWTYPE;
BEGIN
  IF NEW.environment <> 'homologation' THEN RETURN NEW; END IF;
  SELECT * INTO range_row FROM fiscal_homologation_number_ranges
    WHERE tenant_id = NEW.tenant_id AND establishment_id = NEW.establishment_id
      AND series = NEW.series;
  IF NEW.model <> '55' OR range_row.id IS NULL
    OR NEW.last_number < range_row.first_number
    OR NEW.last_number > range_row.last_number THEN
    RAISE EXCEPTION 'Homologation counter must advance within the reviewed range'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_number <> range_row.first_number THEN
      RAISE EXCEPTION 'Homologation counter must start at reviewed first number'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.last_number <> OLD.last_number + 1 THEN
    RAISE EXCEPTION 'Homologation counter must advance one number at a time'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_number_counter_valid
  BEFORE INSERT OR UPDATE ON fiscal_number_counters
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_number_counter();

ALTER TABLE fiscal_number_reservations ADD COLUMN homologation_grant_id uuid;
ALTER TABLE fiscal_number_reservations ADD CONSTRAINT fiscal_homologation_reservation_grant_fk
  FOREIGN KEY (tenant_id, homologation_grant_id)
  REFERENCES fiscal_homologation_drill_grants(tenant_id, id);
ALTER TABLE fiscal_number_reservations ADD CONSTRAINT fiscal_homologation_reservation_grant_required
  CHECK (environment <> 'homologation' OR homologation_grant_id IS NOT NULL);

CREATE FUNCTION verify_fiscal_homologation_number_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row fiscal_homologation_drill_grants%ROWTYPE;
DECLARE range_row fiscal_homologation_number_ranges%ROWTYPE;
BEGIN
  IF NEW.environment <> 'homologation' THEN RETURN NEW; END IF;
  SELECT * INTO grant_row FROM fiscal_homologation_drill_grants
    WHERE tenant_id = NEW.tenant_id AND id = NEW.homologation_grant_id;
  SELECT * INTO range_row FROM fiscal_homologation_number_ranges
    WHERE tenant_id = NEW.tenant_id AND capability_id = grant_row.capability_id
      AND establishment_id = NEW.establishment_id AND series = NEW.series;
  IF grant_row.document_id <> NEW.document_id OR grant_row.expires_at <= now()
    OR NEW.model <> '55' OR range_row.id IS NULL
    OR NEW.number < range_row.first_number OR NEW.number > range_row.last_number
    OR NOT EXISTS (
      SELECT 1 FROM fiscal_number_counters counter
      WHERE counter.tenant_id = NEW.tenant_id
        AND counter.establishment_id = NEW.establishment_id
        AND counter.environment = 'homologation' AND counter.model = '55'
        AND counter.series = NEW.series AND counter.last_number = NEW.number
    ) THEN
    RAISE EXCEPTION 'Homologation number reservation lacks a valid reviewed range and drill'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_number_reservation_valid
  BEFORE INSERT ON fiscal_number_reservations
  FOR EACH ROW EXECUTE FUNCTION verify_fiscal_homologation_number_reservation();
