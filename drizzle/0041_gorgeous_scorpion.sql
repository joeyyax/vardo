ALTER TABLE "image_update_check" ADD COLUMN "available" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "image_update_check" ADD COLUMN "major_available" text;--> statement-breakpoint
ALTER TABLE "image_update_check" ADD COLUMN "major_locked" boolean DEFAULT false NOT NULL;