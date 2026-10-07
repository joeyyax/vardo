ALTER TABLE "backup" DROP CONSTRAINT IF EXISTS "backup_app_id_app_id_fk";
--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "app_name" text;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "backup" SET "app_name" = "app"."name", "organization_id" = "app"."organization_id" FROM "app" WHERE "backup"."app_id" = "app"."id";--> statement-breakpoint
UPDATE "backup" SET "organization_id" = "backup_job"."organization_id" FROM "backup_job" WHERE "backup"."job_id" = "backup_job"."id" AND "backup"."organization_id" IS NULL;
