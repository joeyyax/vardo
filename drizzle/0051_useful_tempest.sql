ALTER TABLE "app" ADD COLUMN "last_running_at" timestamp;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "image_reclaim_policy" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "image_reclaim_idle_days" integer;--> statement-breakpoint
-- Idle age is measured from last_running_at, so existing rows start the clock
-- now. Left null, an app already stopped would never become eligible; backdated
-- to updated_at, it would be eligible on the first sweep.
UPDATE "app" SET "last_running_at" = now();