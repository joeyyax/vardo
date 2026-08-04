ALTER TABLE "volume" DROP CONSTRAINT "volume_dump_requires_meta";--> statement-breakpoint
ALTER TABLE "volume" ADD COLUMN "backup_spec" jsonb;--> statement-breakpoint
ALTER TABLE "volume" ADD CONSTRAINT "volume_dump_requires_meta" CHECK (backup_strategy != 'dump' OR backup_meta IS NOT NULL OR backup_spec IS NOT NULL);