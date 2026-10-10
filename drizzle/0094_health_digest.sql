ALTER TABLE "digest_setting" ADD COLUMN "cadence" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_setting" ADD COLUMN "last_window_key" text;