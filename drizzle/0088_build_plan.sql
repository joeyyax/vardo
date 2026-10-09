ALTER TABLE "app" ADD COLUMN "build_command" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "start_command" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "build_provider" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_plan" jsonb;