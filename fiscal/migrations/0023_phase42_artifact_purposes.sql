-- Keep the historic storage discriminator while admitting the explicit Phase 42
-- purposes. New writes set kind and purpose to the same value; old evidence remains
-- readable without rewriting immutable rows.
ALTER TABLE fiscal_artifacts DROP CONSTRAINT fiscal_artifacts_kind_check;
ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifacts_kind_check CHECK (kind IN (
  'xml', 'response', 'protocol', 'pdf',
  'unsigned_xml', 'signed_xml', 'issuance_request', 'issuance_response',
  'authorization_protocol', 'cancellation_request', 'cancellation_response',
  'cancellation_protocol', 'danfe'
));

ALTER TABLE fiscal_artifacts ADD CONSTRAINT fiscal_artifact_explicit_purpose CHECK (
  purpose IS NULL OR purpose = kind
);
