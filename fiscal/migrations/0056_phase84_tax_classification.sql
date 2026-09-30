-- Phase 84: rules and references may name the IBS/CBS tax classification (cClassTrib).
ALTER TABLE fiscal_tax_rules DROP CONSTRAINT fiscal_tax_rules_classification_kind_check;
ALTER TABLE fiscal_tax_rules ADD CONSTRAINT fiscal_tax_rules_classification_kind_check CHECK (
  classification_kind IN ('*', 'ncm', 'cest', 'service', 'origin', 'class_trib')
);
ALTER TABLE fiscal_catalog_rules DROP CONSTRAINT fiscal_catalog_rules_classification_kind_check;
ALTER TABLE fiscal_catalog_rules ADD CONSTRAINT fiscal_catalog_rules_classification_kind_check CHECK (
  classification_kind IN ('*', 'ncm', 'cest', 'service', 'origin', 'class_trib')
);
ALTER TABLE fiscal_reference_entries DROP CONSTRAINT fiscal_reference_entries_family_check;
ALTER TABLE fiscal_reference_entries ADD CONSTRAINT fiscal_reference_entries_family_check CHECK (
  family IN ('cfop', 'ncm', 'cest', 'cst', 'csosn', 'ibs_cbs', 'service', 'class_trib')
);
ALTER TABLE fiscal_catalog_references DROP CONSTRAINT fiscal_catalog_references_family_check;
ALTER TABLE fiscal_catalog_references ADD CONSTRAINT fiscal_catalog_references_family_check CHECK (
  family IN ('cfop', 'ncm', 'cest', 'cst', 'csosn', 'ibs_cbs', 'service', 'class_trib')
);
