-- Phase 48: operator worklist, support snapshot and bounded outbox replay.

-- The worklist reads newest first by (created_at, id) inside one tenant.
CREATE INDEX fiscal_documents_worklist
  ON fiscal_documents (tenant_id, created_at DESC, id DESC);
CREATE INDEX fiscal_documents_status
  ON fiscal_documents (tenant_id, status);
CREATE INDEX fiscal_outbox_undelivered
  ON fiscal_outbox (tenant_id, created_at) WHERE delivered_at IS NULL;
CREATE INDEX fiscal_dispatch_commands_document
  ON fiscal_dispatch_commands (tenant_id, document_id);

-- A delivered outbox event stays immutable (0024). Republishing it is a separate,
-- audited request that the relay sends again with the same event id, which consumers
-- already deduplicate. At most one replay of an event is pending at a time.
CREATE TABLE fiscal_outbox_replays (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL,
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT fiscal_outbox_replay_event_fk FOREIGN KEY (tenant_id, event_id)
    REFERENCES fiscal_outbox (tenant_id, event_id)
);
CREATE UNIQUE INDEX fiscal_outbox_replay_pending
  ON fiscal_outbox_replays (tenant_id, event_id) WHERE delivered_at IS NULL;

CREATE FUNCTION guard_fiscal_outbox_replay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.event_id IS DISTINCT FROM NEW.event_id
    OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
    OR OLD.delivered_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Fiscal outbox replay is append-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_outbox_replay_guard BEFORE UPDATE OR DELETE ON fiscal_outbox_replays
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_outbox_replay();

ALTER TABLE fiscal_outbox_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_outbox_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON fiscal_outbox_replays TO horizon_app
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
GRANT SELECT, INSERT, UPDATE ON fiscal_outbox_replays TO horizon_app;

-- The last rejection code of a document is read from its outcome events.
CREATE INDEX fiscal_outbox_document
  ON fiscal_outbox (tenant_id, (payload->>'documentId'), created_at DESC);
