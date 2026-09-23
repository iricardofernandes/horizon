-- A packed scoped shipment cannot escape its policy by changing the warehouse,
-- and a frozen fiscal origin must continue to describe the exact shipment bytes.
CREATE FUNCTION reject_sales_frozen_shipment_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.order_id, NEW.warehouse_id, NEW.value, NEW.currency)
      IS NOT DISTINCT FROM
     (OLD.tenant_id, OLD.order_id, OLD.warehouse_id, OLD.value, OLD.currency) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM sales_fiscal_origin_freezes frozen
    WHERE frozen.tenant_id = OLD.tenant_id AND frozen.shipment_id = OLD.id
  ) OR (OLD.status = 'packed' AND EXISTS (
    SELECT 1 FROM sales_fiscal_dispatch_policies policy
    WHERE policy.tenant_id = OLD.tenant_id AND policy.warehouse_id = OLD.warehouse_id
  )) THEN
    IF (NEW.tenant_id, NEW.order_id, NEW.warehouse_id, NEW.currency)
        IS DISTINCT FROM
       (OLD.tenant_id, OLD.order_id, OLD.warehouse_id, OLD.currency)
      OR (NEW.value IS DISTINCT FROM OLD.value AND NOT (
        OLD.status = 'packed' AND NEW.status = 'dispatched' AND NEW.value = (
          SELECT COALESCE(sum(line_total), 0)::bigint FROM shipment_lines
          WHERE tenant_id = OLD.tenant_id AND shipment_id = OLD.id
        )
      )) THEN
      RAISE EXCEPTION 'Scoped shipment fiscal origin is frozen'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_fiscal_shipment_origin_immutable
  BEFORE UPDATE OF tenant_id, order_id, warehouse_id, value, currency ON shipments
  FOR EACH ROW EXECUTE FUNCTION reject_sales_frozen_shipment_mutation();
--> statement-breakpoint
CREATE FUNCTION reject_sales_frozen_shipment_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_tenant uuid;
DECLARE target_shipment uuid;
BEGIN
  target_tenant := CASE WHEN TG_OP = 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END;
  target_shipment := CASE WHEN TG_OP = 'INSERT' THEN NEW.shipment_id ELSE OLD.shipment_id END;
  IF EXISTS (
    SELECT 1 FROM sales_fiscal_origin_freezes frozen
    WHERE frozen.tenant_id = target_tenant AND frozen.shipment_id = target_shipment
  ) THEN
    RAISE EXCEPTION 'Scoped shipment lines are frozen for fiscal origin'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND
    (NEW.tenant_id, NEW.shipment_id) IS DISTINCT FROM (OLD.tenant_id, OLD.shipment_id)
    AND EXISTS (
      SELECT 1 FROM sales_fiscal_origin_freezes frozen
      WHERE frozen.tenant_id = NEW.tenant_id AND frozen.shipment_id = NEW.shipment_id
    ) THEN
    RAISE EXCEPTION 'Scoped shipment lines are frozen for fiscal origin'
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_fiscal_shipment_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON shipment_lines
  FOR EACH ROW EXECUTE FUNCTION reject_sales_frozen_shipment_line_mutation();
