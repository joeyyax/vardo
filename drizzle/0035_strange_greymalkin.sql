ALTER TYPE "public"."app_status" ADD VALUE 'missing';--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "container_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "status_checked_at" timestamp;