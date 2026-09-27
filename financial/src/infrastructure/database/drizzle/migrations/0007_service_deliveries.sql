-- Phase 50: a delivered service raises what it billed, exactly as a shipment does for
-- goods (ADR 0056). The delivery is the origin document, so a replay finds the same title.
ALTER TABLE "titles" DROP CONSTRAINT "titles_origin_type_check";
ALTER TABLE "titles" ADD CONSTRAINT "titles_origin_type_check" CHECK (
  "origin_type" IN (
    'manual', 'sales-order', 'purchase-order', 'purchase-receipt', 'sales-shipment',
    'sales-service-delivery'
  )
);
