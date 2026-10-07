ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "archive_key" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "archive_key_fingerprint" text;