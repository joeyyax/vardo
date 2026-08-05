ALTER TABLE "backup" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "verify_outcome" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "verify_detail" text;