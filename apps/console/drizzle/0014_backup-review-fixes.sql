-- Replace unique constraints with composite primary keys on join tables
ALTER TABLE "backup_job_app" DROP CONSTRAINT IF EXISTS "backup_job_app_uniq";--> statement-breakpoint
ALTER TABLE "backup_job_app" ADD CONSTRAINT "backup_job_app_backup_job_id_app_id_pk" PRIMARY KEY("backup_job_id","app_id");--> statement-breakpoint

ALTER TABLE "backup_job_volume" DROP CONSTRAINT IF EXISTS "backup_job_volume_uniq";--> statement-breakpoint
ALTER TABLE "backup_job_volume" ADD CONSTRAINT "backup_job_volume_backup_job_id_volume_id_pk" PRIMARY KEY("backup_job_id","volume_id");--> statement-breakpoint

-- Ensure dump strategy always has backup_meta
ALTER TABLE "volume" ADD CONSTRAINT "volume_dump_requires_meta" CHECK (backup_strategy != 'dump' OR backup_meta IS NOT NULL);
