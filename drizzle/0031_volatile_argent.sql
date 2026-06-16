CREATE TYPE "public"."app_priority" AS ENUM('critical', 'standard', 'disposable');--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "priority" "app_priority" DEFAULT 'standard' NOT NULL;