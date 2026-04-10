DROP TABLE IF EXISTS "integration" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "plugin_setting" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "plugin" CASCADE;--> statement-breakpoint
ALTER TABLE "app" DROP CONSTRAINT IF EXISTS "app_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "app" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "is_system_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_type";
