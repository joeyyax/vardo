ALTER TABLE "backup_job" DROP CONSTRAINT IF EXISTS "backup_job_target_id_backup_target_id_fk";--> statement-breakpoint
ALTER TABLE "backup" DROP CONSTRAINT IF EXISTS "backup_target_id_backup_target_id_fk";--> statement-breakpoint
ALTER TABLE "backup_job" ADD CONSTRAINT "backup_job_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE no action ON UPDATE no action;
