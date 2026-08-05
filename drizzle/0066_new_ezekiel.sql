ALTER TABLE "volume" ADD COLUMN "backup_exclude_patterns" jsonb;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "excluded_paths" jsonb;