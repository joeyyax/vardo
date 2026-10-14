ALTER TABLE "deployment" ADD COLUMN "wait_eta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "bumped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "claimed_at" timestamp with time zone;