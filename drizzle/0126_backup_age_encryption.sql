ALTER TABLE "backup" ADD COLUMN "encrypted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "backup" SET "encrypted" = true WHERE "archive_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "backup" DROP COLUMN "archive_key";--> statement-breakpoint
ALTER TABLE "backup" DROP COLUMN "archive_key_fingerprint";