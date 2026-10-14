CREATE TABLE "worker_job" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scope_key" text,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "request" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "exclusive_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "worker_job_queued_idx" ON "worker_job" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_scope_running_uniq" ON "deployment" USING btree ("scope_key") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "deployment_queued_idx" ON "deployment" USING btree ("started_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "deployment_exclusive_idx" ON "deployment" USING btree ("exclusive_requested_at") WHERE exclusive_requested_at is not null;