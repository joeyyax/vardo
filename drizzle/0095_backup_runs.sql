CREATE TABLE "backup_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_key" text NOT NULL,
	"label" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"estimated_ms" integer,
	"deadline_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"plan" jsonb NOT NULL,
	"jobs_done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_job" ADD COLUMN "nightly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "nightly_backup_time" text DEFAULT '02:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_run_key_idx" ON "backup_run" USING btree ("organization_id","run_key");--> statement-breakpoint
CREATE INDEX "backup_run_open_idx" ON "backup_run" USING btree ("organization_id") WHERE "backup_run"."finished_at" is null;--> statement-breakpoint
ALTER TABLE "notification_setting" DROP COLUMN "batch_window_minutes";--> statement-breakpoint
-- Auto jobs still on the schedule Vardo gave them join the nightly run. A schedule someone changed stays.
UPDATE "backup_job" SET "nightly" = true, "schedule" = '0 2 * * *', "updated_at" = now() WHERE "organization_id" IS NOT NULL AND "name" LIKE 'Auto: %' AND EXISTS (SELECT 1 FROM "backup_job_app" bja WHERE bja."backup_job_id" = "backup_job"."id" AND (get_byte(decode(md5(bja."app_id"), 'hex'), 0) % 60)::text || ' ' || (get_byte(decode(md5(bja."app_id"), 'hex'), 1) % 6)::text || ' * * *' = "backup_job"."schedule");
