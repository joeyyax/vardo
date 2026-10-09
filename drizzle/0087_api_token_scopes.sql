-- Existing tokens keep full access through the default.
ALTER TABLE "api_token" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "capabilities" text[];
