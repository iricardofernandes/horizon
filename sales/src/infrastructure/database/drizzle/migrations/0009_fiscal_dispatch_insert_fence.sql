-- A direct INSERT must not bypass the scoped UPDATE fence by creating a
-- shipment already marked dispatched or returned.
CREATE FUNCTION reject_sales_scoped_direct_dispatch_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('dispatched', 'returned') AND EXISTS (
    SELECT 1 FROM sales_fiscal_dispatch_policies policy
    WHERE policy.tenant_id = NEW.tenant_id
      AND policy.warehouse_id = NEW.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Scoped shipment cannot be inserted as dispatched or returned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sales_fiscal_dispatch_insert_valid
  BEFORE INSERT ON shipments
  FOR EACH ROW EXECUTE FUNCTION reject_sales_scoped_direct_dispatch_insert();
