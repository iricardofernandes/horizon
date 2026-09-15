ALTER TABLE "accounts" ADD COLUMN "preferred_locale" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "trade_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state_registration" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "municipal_registration" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_state" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_country" text DEFAULT 'BR' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "base_currency" text DEFAULT 'BRL' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "fiscal_regime" text DEFAULT 'not-declared' NOT NULL;
