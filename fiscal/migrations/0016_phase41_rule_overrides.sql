CREATE TABLE fiscal_rule_override_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  predecessor_rule_id uuid NOT NULL,
  proposed_definition jsonb NOT NULL CHECK (jsonb_typeof(proposed_definition) = 'object'),
  before_digest text NOT NULL CHECK (before_digest ~ '^[0-9a-f]{64}$'),
  proposed_digest text NOT NULL CHECK (proposed_digest ~ '^[0-9a-f]{64}$'),
  source_basis_uri text NOT NULL,
  source_basis_section text NOT NULL CHECK (length(source_basis_section) BETWEEN 1 AND 300),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'proposed' CHECK (status = 'proposed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_rule_override_predecessor_fk FOREIGN KEY (tenant_id, predecessor_rule_id)
    REFERENCES fiscal_tax_rules(tenant_id, id),
  CONSTRAINT fiscal_rule_override_proposal_key UNIQUE (
    tenant_id, predecessor_rule_id, proposed_digest, reason
  ),
  CONSTRAINT fiscal_rule_override_tenant_id_key UNIQUE (tenant_id, id)
);

ALTER TABLE fiscal_rule_override_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_rule_override_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_rule_override_proposals TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);

GRANT SELECT, INSERT ON fiscal_rule_override_proposals TO horizon_app;
CREATE TRIGGER fiscal_rule_override_proposals_immutable
  BEFORE UPDATE OR DELETE ON fiscal_rule_override_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
