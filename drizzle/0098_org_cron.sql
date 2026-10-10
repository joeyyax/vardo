ALTER TABLE "cron_job" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job_run" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "cron_job_run" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "cron_job_run" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "cron_job" SET "organization_id" = "app"."organization_id" FROM "app" WHERE "app"."id" = "cron_job"."app_id";--> statement-breakpoint
ALTER TABLE "cron_job" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "method" text DEFAULT 'GET' NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "headers" text;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "timeout_ms" integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_job" ADD COLUMN "expected_status" text;--> statement-breakpoint
ALTER TABLE "cron_job" ADD CONSTRAINT "cron_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_job_org_idx" ON "cron_job" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "cron_job" ADD CONSTRAINT "cron_job_command_needs_app" CHECK (type <> 'command' OR app_id IS NOT NULL);