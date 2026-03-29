ALTER TABLE "app" ADD COLUMN "imported_compose_project" text;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_imported_compose_project_uniq" UNIQUE("organization_id","imported_compose_project");
