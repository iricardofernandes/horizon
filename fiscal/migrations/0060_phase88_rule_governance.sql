-- Phase 88 (ADR 0074): every change to the rules a workspace calculates with is a request
-- another person approves, shown with its diff and its impact; and Fiscal lends its approval
-- like the other modules of ADR 0062's matrix.

CREATE TABLE fiscal_approval_delegations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  permission text NOT NULL CHECK (permission = 'fiscal:rules:approve'),
  delegator_id text NOT NULL CHECK (length(delegator_id) BETWEEN 1 AND 200),
  delegate_id text NOT NULL CHECK (length(delegate_id) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 200),
  CHECK (delegate_id <> delegator_id),
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '90 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX fiscal_approval_delegations_delegate
  ON fiscal_approval_delegations (tenant_id, delegate_id, permission);

-- A revocation is the one change a delegation takes, and only once.
CREATE FUNCTION guard_fiscal_delegation_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR (to_jsonb(NEW) - 'revoked_at' - 'revoked_by') <> (to_jsonb(OLD) - 'revoked_at' - 'revoked_by') THEN
    RAISE EXCEPTION 'a fiscal delegation only takes one revocation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_approval_delegations_revocation
  BEFORE UPDATE ON fiscal_approval_delegations
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_delegation_revocation();
CREATE TRIGGER fiscal_approval_delegations_kept
  BEFORE DELETE ON fiscal_approval_delegations
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();

CREATE TABLE fiscal_rule_changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('adopt-package', 'withdraw-package', 'add-rule', 'retire-rule')),
  -- What the change is about, so two pending requests never compete for it.
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 200),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  diff jsonb NOT NULL CHECK (jsonb_typeof(diff) = 'object'),
  impact jsonb NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  impact_digest text NOT NULL CHECK (impact_digest ~ '^[0-9a-f]{64}$'),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_rule_changes_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX fiscal_rule_changes_newest ON fiscal_rule_changes (tenant_id, sequence DESC);
CREATE INDEX fiscal_rule_changes_subject ON fiscal_rule_changes (tenant_id, subject_key);

CREATE TABLE fiscal_rule_change_decisions (
  tenant_id uuid NOT NULL,
  change_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('approved', 'rejected', 'cancelled')),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 200),
  on_behalf_of text CHECK (on_behalf_of IS NULL OR length(on_behalf_of) BETWEEN 1 AND 200),
  delegation_id uuid,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  result_id uuid,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, change_id),
  FOREIGN KEY (tenant_id, change_id) REFERENCES fiscal_rule_changes (tenant_id, id),
  CHECK ((on_behalf_of IS NULL) = (delegation_id IS NULL)),
  CHECK (outcome = 'approved' OR result_id IS NULL)
);

-- Whoever asked never decides, either way, even through a delegation (ADR 0062). The
-- application refuses it first; this keeps any other path from recording it.
CREATE FUNCTION guard_fiscal_rule_change_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  requester text;
BEGIN
  SELECT requested_by INTO requester FROM fiscal_rule_changes
  WHERE tenant_id = NEW.tenant_id AND id = NEW.change_id;
  IF NEW.outcome = 'cancelled' THEN
    IF NEW.decided_by <> requester OR NEW.on_behalf_of IS NOT NULL THEN
      RAISE EXCEPTION 'only the requester cancels a fiscal rule change' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.decided_by = requester OR NEW.on_behalf_of = requester THEN
    RAISE EXCEPTION 'segregation of duties: the requester cannot decide a fiscal rule change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fiscal_rule_change_decision_duties
  BEFORE INSERT ON fiscal_rule_change_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_rule_change_decision();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['fiscal_approval_delegations', 'fiscal_rule_changes', 'fiscal_rule_change_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO horizon_app
      USING (tenant_id = current_setting('app.current_tenant')::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid)$policy$, table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON fiscal_approval_delegations TO horizon_app;
GRANT UPDATE (revoked_at, revoked_by) ON fiscal_approval_delegations TO horizon_app;
GRANT SELECT, INSERT ON fiscal_rule_changes, fiscal_rule_change_decisions TO horizon_app;

CREATE TRIGGER fiscal_rule_changes_immutable
  BEFORE UPDATE OR DELETE ON fiscal_rule_changes
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
CREATE TRIGGER fiscal_rule_change_decisions_immutable
  BEFORE UPDATE OR DELETE ON fiscal_rule_change_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
