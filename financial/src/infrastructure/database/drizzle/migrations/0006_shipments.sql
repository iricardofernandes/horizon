-- A delivery to a customer raises what it made owed, exactly as a goods receipt does on
-- the buying side. The order it belongs to keeps the forecast for what is left to deliver.
ALTER TABLE "titles" DROP CONSTRAINT "titles_origin_type_check";
ALTER TABLE "titles" ADD CONSTRAINT "titles_origin_type_check" CHECK (
  "origin_type" IN ('manual', 'sales-order', 'purchase-order', 'purchase-receipt', 'sales-shipment')
);
