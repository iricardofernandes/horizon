-- The inventory control account (Phase 69): stock is not posted, so the account is kept by
-- manual entries, and Reporting's consistency check compares it with the stock valuation.
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_role_check";
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_role_check" CHECK ("role" IN (
  'receivables', 'payables', 'cash', 'revenue', 'expense', 'discount-granted',
  'discount-received', 'financial-income', 'financial-expense', 'bank-fees',
  'opening-balance', 'suspense', 'inventory'
));
