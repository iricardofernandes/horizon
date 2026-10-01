-- Phase 87 (ADR 0073): Fiscal's estimate of a purchase order's taxes. Its taxes charged on top
-- of the price replace the typed tax, and the approved order carries it so Fiscal can compare
-- the supplier's NF-e with it.
ALTER TABLE "orders" ADD COLUMN "tax_estimate" jsonb CHECK ("tax_estimate" IS NULL OR jsonb_typeof("tax_estimate") = 'object');
-- The application updates orders column by column; this column is one it writes.
GRANT UPDATE ("tax_estimate") ON orders TO horizon_app;
