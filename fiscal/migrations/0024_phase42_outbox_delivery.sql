-- The relay may acknowledge delivery, while event identity and payload remain immutable.
CREATE FUNCTION guard_fiscal_outbox_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.event_id IS DISTINCT FROM NEW.event_id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (OLD.delivered_at IS NOT NULL AND OLD.delivered_at IS DISTINCT FROM NEW.delivered_at)
  THEN
    RAISE EXCEPTION 'Fiscal outbox event is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_outbox_delivery_guard BEFORE UPDATE ON fiscal_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_outbox_delivery();
GRANT UPDATE ON fiscal_outbox TO horizon_app;
