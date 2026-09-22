CREATE TABLE fiscal_origin_payloads (
  tenant_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, intent_id),
  CONSTRAINT fiscal_origin_payload_intent_fk FOREIGN KEY (tenant_id, intent_id)
    REFERENCES fiscal_intents(tenant_id, id)
);
ALTER TABLE fiscal_origin_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_origin_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_origin_payloads TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT ON fiscal_origin_payloads TO horizon_app;
CREATE TRIGGER fiscal_origin_payloads_immutable BEFORE UPDATE OR DELETE ON fiscal_origin_payloads
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_immutable_mutation();
