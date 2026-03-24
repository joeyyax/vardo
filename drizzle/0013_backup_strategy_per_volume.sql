-- Add backup strategy columns to volumes
ALTER TABLE "volume" ADD COLUMN "backup_strategy" text DEFAULT 'tar' NOT NULL;--> statement-breakpoint
ALTER TABLE "volume" ADD COLUMN "backup_meta" jsonb;--> statement-breakpoint
ALTER TABLE "volume" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "volume" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint

-- Create backup_job_volume join table for direct volume links
CREATE TABLE IF NOT EXISTS "backup_job_volume" (
  "backup_job_id" text NOT NULL REFERENCES "backup_job"("id") ON DELETE CASCADE,
  "volume_id" text NOT NULL REFERENCES "volume"("id") ON DELETE CASCADE,
  CONSTRAINT "backup_job_volume_uniq" UNIQUE("backup_job_id", "volume_id")
);--> statement-breakpoint

-- Remove isSystem from backup_job (strategy lives on the volume now)
ALTER TABLE "backup_job" DROP COLUMN IF EXISTS "is_system";
