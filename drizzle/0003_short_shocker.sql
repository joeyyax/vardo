ALTER TYPE "public"."deployment_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "superseded_by" text;