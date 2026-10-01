-- Phase 89: each run of the official calculator against the published IBS/CBS packages
-- (`make tax-oracle`), recorded so Fiscal can export the last run's disagreements and age.
-- The oracle checks the shared catalogue, so a run belongs to no workspace.
CREATE TABLE fiscal_tax_oracle_runs (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9-]{1,40}$'),
  calculator_version text NOT NULL CHECK (length(calculator_version) BETWEEN 1 AND 40),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  documents integer NOT NULL CHECK (documents >= 0),
  lines integer NOT NULL CHECK (lines >= 0),
  agreed integer NOT NULL CHECK (agreed >= 0),
  differed integer NOT NULL CHECK (differed >= 0),
  refused integer NOT NULL CHECK (refused >= 0),
  report_digest text NOT NULL CHECK (report_digest ~ '^[0-9a-f]{64}$'),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  ran_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_tax_oracle_runs_report UNIQUE (report_digest)
);

CREATE INDEX fiscal_tax_oracle_runs_latest ON fiscal_tax_oracle_runs (kind, sequence DESC);

ALTER TABLE fiscal_tax_oracle_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_tax_oracle_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY oracle_runs ON fiscal_tax_oracle_runs TO horizon_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON fiscal_tax_oracle_runs TO horizon_app;
GRANT USAGE, SELECT ON SEQUENCE fiscal_tax_oracle_runs_sequence_seq TO horizon_app;
CREATE TRIGGER fiscal_tax_oracle_runs_immutable
  BEFORE UPDATE OR DELETE ON fiscal_tax_oracle_runs
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
