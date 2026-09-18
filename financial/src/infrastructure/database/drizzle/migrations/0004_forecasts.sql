-- How firm a title is. A forecast is money the workspace expects — an order confirmed but
-- not yet invoiced — and is not a claim on anyone: it never posts, never counts as a
-- receivable or a payable, and never reaches the ledger.
--
-- Everything that already exists is effective: forecasts did not exist until now.
ALTER TABLE "titles" ADD COLUMN "stage" text NOT NULL DEFAULT 'effective'
  CHECK ("stage" IN ('forecast', 'effective'));
ALTER TABLE "titles" ADD COLUMN "realised_at" timestamp with time zone;
--> statement-breakpoint
-- The default exists to fill the rows already there; a new row says which stage it is.
ALTER TABLE "titles" ALTER COLUMN "stage" DROP DEFAULT;
--> statement-breakpoint
-- Invoicing turns a forecast effective in place, so a posted title is always effective and
-- a realised one always carries when it happened.
ALTER TABLE "titles" ADD CONSTRAINT "titles_forecast_posting_check" CHECK (
  "stage" = 'effective' OR "status" IN ('draft', 'cancelled')
);
ALTER TABLE "titles" ADD CONSTRAINT "titles_realised_check" CHECK (
  ("realised_at" IS NOT NULL) <= ("stage" = 'effective')
);
--> statement-breakpoint
GRANT UPDATE ("stage", "realised_at") ON titles TO horizon_app;
--> statement-breakpoint
CREATE INDEX "titles_forecast_idx" ON "titles" ("tenant_id", "direction", "stage", "issued_on")
  WHERE "stage" = 'forecast';
