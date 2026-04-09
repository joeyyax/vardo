ALTER TABLE "integration" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plugin_setting" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plugin" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "integration" CASCADE;--> statement-breakpoint
DROP TABLE "plugin_setting" CASCADE;--> statement-breakpoint
DROP TABLE "plugin" CASCADE;--> statement-breakpoint
ALTER TABLE "app" DROP CONSTRAINT "app_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "app" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "is_system_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."integration_status";--> statement-breakpoint
DROP TYPE "public"."integration_type";