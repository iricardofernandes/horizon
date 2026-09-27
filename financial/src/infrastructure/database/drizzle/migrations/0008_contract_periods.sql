-- Phase 52: a billed contract period raises what it billed, as a service delivery does
-- (ADR 0056). The billed period is the origin document, so a replay finds the same title.
ALTER TABLE "titles" DROP CONSTRAINT "titles_origin_type_check";
ALTER TABLE "titles" ADD CONSTRAINT "titles_origin_type_check" CHECK (
  "origin_type" IN (
    'manual', 'sales-order', 'purchase-order', 'purchase-receipt', 'sales-shipment',
    'sales-service-delivery', 'sales-contract-period'
  )
);
