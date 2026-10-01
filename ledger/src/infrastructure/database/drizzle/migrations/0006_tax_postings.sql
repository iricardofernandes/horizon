-- Phase 87 (ADR 0073): the taxes a Fiscal lock says a sale contains, per component. They are
-- deducted from revenue (sales-taxes) and owed to the tax authority (taxes-payable); each may
-- be chosen per component, keyed by its code. A lock posts once, as its document's fact.
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_role_check";
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_role_check" CHECK ("role" IN (
  'receivables', 'payables', 'cash', 'revenue', 'expense', 'discount-granted',
  'discount-received', 'financial-income', 'financial-expense', 'bank-fees',
  'opening-balance', 'suspense', 'inventory', 'sales-taxes', 'taxes-payable'
));
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_keyed_check";
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_keyed_check" CHECK (
  "key" = '' OR "role" IN ('cash', 'revenue', 'expense', 'sales-taxes', 'taxes-payable')
);
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_source_type_check";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_type_check" CHECK (
  "source_type" IN ('manual', 'receivable', 'payable', 'settlement', 'transfer', 'treasury-entry', 'tax-lock')
);
ALTER TABLE "posting_facts" DROP CONSTRAINT "posting_facts_kind_check";
ALTER TABLE "posting_facts" ADD CONSTRAINT "posting_facts_kind_check" CHECK (
  "kind" IN ('receivable', 'payable', 'settlement', 'transfer', 'treasury-entry', 'tax-lock')
);
