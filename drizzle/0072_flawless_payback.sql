ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "job_name" text;--> statement-breakpoint
UPDATE "backup" SET "job_name" = "backup_job"."name" FROM "backup_job" WHERE "backup"."job_id" = "backup_job"."id" AND "backup"."job_name" IS NULL;--> statement-breakpoint
ALTER TABLE "backup" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backup" DROP CONSTRAINT IF EXISTS "backup_job_id_backup_job_id_fk";--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_job_id_backup_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."backup_job"("id") ON DELETE set null ON UPDATE no action;
