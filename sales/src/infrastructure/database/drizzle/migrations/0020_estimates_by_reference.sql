-- Phase 91 (ADR 0076): an estimate is of the lines it was asked for. Revising a draft quote
-- removes the estimate it had, so the application may delete one.
GRANT DELETE ON tax_estimates TO horizon_app;
--> statement-breakpoint
-- A draft or pending quote is rewritten with its lines, which the application was never
-- allowed to delete: revising a draft, or sending one for a discount approval, failed
-- against the database. The lines of a sent quote stay untouched by the code that saves it.
GRANT DELETE ON quote_lines TO horizon_app;
