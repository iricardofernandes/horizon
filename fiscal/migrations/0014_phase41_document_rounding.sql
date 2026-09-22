ALTER TABLE fiscal_tax_rules DROP CONSTRAINT fiscal_tax_rules_formula_check;
ALTER TABLE fiscal_tax_rules ADD CONSTRAINT fiscal_tax_rules_formula_check CHECK (
  formula IN ('LINE_NET_TIMES_RATE', 'DOCUMENT_NET_TIMES_RATE')
);
