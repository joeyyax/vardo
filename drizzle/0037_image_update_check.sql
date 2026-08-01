CREATE TABLE "image_update_check" (
	"image_ref" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"latest_tag" text,
	"severity" text,
	"remote_digest" text,
	"unorderable" jsonb DEFAULT '[]'::jsonb,
	"error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_update_check_checked_at_idx" ON "image_update_check" USING btree ("checked_at");