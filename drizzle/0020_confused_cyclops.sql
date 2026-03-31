ALTER TABLE "app" ADD COLUMN "is_system_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "is_system_managed" boolean DEFAULT false NOT NULL;