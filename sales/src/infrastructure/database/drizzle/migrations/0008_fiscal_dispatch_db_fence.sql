-- Enforce the same scoped release predicate at the shipment write boundary.
-- The application still owns the dispatch decision and its business events.
CREATE FUNCTION require_sales_fiscal_dispatch_release()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_establishment uuid;
DECLARE frozen sales_fiscal_origin_freezes%ROWTYPE;
DECLARE order_version integer;
DECLARE latest sales_fiscal_release_observations%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('dispatched', 'returned')
    OR OLD.status IN ('dispatched', 'returned') THEN RETURN NEW; END IF;
  SELECT establishment_id INTO policy_establishment
    FROM sales_fiscal_dispatch_policies
    WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id;
  IF policy_establishment IS NULL THEN RETURN NEW; END IF;
  IF OLD.status <> 'packed' OR NEW.status <> 'dispatched' OR NEW.order_id <> OLD.order_id
    OR NEW.warehouse_id <> OLD.warehouse_id THEN
    RAISE EXCEPTION 'Scoped shipment must dispatch from its frozen packed state'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO frozen FROM sales_fiscal_origin_freezes
    WHERE tenant_id = NEW.tenant_id AND shipment_id = NEW.id;
  SELECT version INTO order_version FROM sales_orders
    WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF frozen.shipment_id IS NULL OR frozen.order_id <> NEW.order_id
    OR frozen.warehouse_id <> NEW.warehouse_id
    OR frozen.establishment_id <> policy_establishment
    OR frozen.order_version <> order_version THEN
    RAISE EXCEPTION 'Scoped shipment lacks its exact frozen fiscal origin'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO latest FROM sales_fiscal_release_observations
    WHERE tenant_id = NEW.tenant_id AND shipment_id = NEW.id
    ORDER BY document_revision DESC, observed_at DESC, event_id DESC LIMIT 1;
  IF latest.event_id IS NULL OR latest.environment <> 'production'
    OR latest.outcome <> 'authorized'
    OR latest.origin_digest <> frozen.payload_digest
    OR latest.order_version <> frozen.order_version
    OR latest.establishment_id <> policy_establishment
    OR EXISTS (
      SELECT 1 FROM sales_fiscal_release_observations blocking
      WHERE blocking.tenant_id = NEW.tenant_id AND blocking.shipment_id = NEW.id
        AND blocking.document_revision >= latest.document_revision
        AND blocking.outcome IN ('rejected', 'cancelled')
    ) THEN
    RAISE EXCEPTION 'Scoped shipment lacks production fiscal authorization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_fiscal_dispatch_release_valid
  BEFORE UPDATE OF status ON shipments
  FOR EACH ROW EXECUTE FUNCTION require_sales_fiscal_dispatch_release();
