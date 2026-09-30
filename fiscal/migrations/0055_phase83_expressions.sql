-- Phase 83 (ADR 0071): a rule may build its base with an expression over a closed vocabulary.
-- The expression is validated when a package is imported or published; the database keeps it
-- and holds the formula and the expression together.
ALTER TABLE fiscal_tax_rules ADD COLUMN expression jsonb;
ALTER TABLE fiscal_tax_rules DROP CONSTRAINT fiscal_tax_rules_formula_check;
ALTER TABLE fiscal_tax_rules ADD CONSTRAINT fiscal_tax_rules_formula_check CHECK (
  formula IN ('LINE_NET_TIMES_RATE', 'DOCUMENT_NET_TIMES_RATE', 'RETURN_LINE_NET_TIMES_RATE', 'EXPRESSION')
);
ALTER TABLE fiscal_tax_rules ADD CONSTRAINT fiscal_tax_rules_expression CHECK (
  (formula = 'EXPRESSION') = (expression IS NOT NULL)
  AND (expression IS NULL OR jsonb_typeof(expression) = 'object')
);

ALTER TABLE fiscal_catalog_rules ADD COLUMN expression jsonb;
ALTER TABLE fiscal_catalog_rules DROP CONSTRAINT fiscal_catalog_rules_formula_check;
ALTER TABLE fiscal_catalog_rules ADD CONSTRAINT fiscal_catalog_rules_formula_check CHECK (
  formula IN ('LINE_NET_TIMES_RATE', 'DOCUMENT_NET_TIMES_RATE', 'RETURN_LINE_NET_TIMES_RATE', 'EXPRESSION')
);
ALTER TABLE fiscal_catalog_rules ADD CONSTRAINT fiscal_catalog_rules_expression CHECK (
  (formula = 'EXPRESSION') = (expression IS NOT NULL)
  AND (expression IS NULL OR jsonb_typeof(expression) = 'object')
);
