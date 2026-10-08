ALTER TABLE "domain" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "org_domain" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "org_domain" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "base_domain_token" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "base_domain_verified_at" timestamp;--> statement-breakpoint
UPDATE "domain" SET "verification_token" = 'vardo-' || replace(gen_random_uuid()::text, '-', '');--> statement-breakpoint
UPDATE "org_domain" SET "verification_token" = 'vardo-' || replace(gen_random_uuid()::text, '-', ''), "verified_at" = CASE WHEN "verified" THEN "created_at" END;--> statement-breakpoint
UPDATE "organization" SET "base_domain_token" = 'vardo-' || replace(gen_random_uuid()::text, '-', '') WHERE "base_domain" IS NOT NULL;
