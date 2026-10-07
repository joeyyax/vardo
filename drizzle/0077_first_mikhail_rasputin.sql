ALTER TABLE "app" ADD COLUMN IF NOT EXISTS "backups_enabled" boolean;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "backups_enabled" boolean;--> statement-breakpoint
-- Enrolled apps keep their state: on with an enabled job, off when every job covering them is disabled.
UPDATE "app" SET "backups_enabled" = covered."enabled"
FROM (
  SELECT bja."app_id", bool_or(bj."enabled") AS "enabled"
  FROM "backup_job_app" bja
  JOIN "backup_job" bj ON bj."id" = bja."backup_job_id"
  JOIN "app" a ON a."id" = bja."app_id"
  WHERE bj."organization_id" = a."organization_id" OR bj."organization_id" IS NULL
  GROUP BY bja."app_id"
) covered
WHERE "app"."id" = covered."app_id" AND "app"."backups_enabled" IS NULL;
