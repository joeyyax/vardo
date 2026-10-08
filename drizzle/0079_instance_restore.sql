CREATE TABLE "instance_restore_app" (
	"id" text PRIMARY KEY NOT NULL,
	"restore_id" text NOT NULL,
	"app_id" text NOT NULL,
	"app_name" text NOT NULL,
	"organization_id" text NOT NULL,
	"priority" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"position" integer NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"redeploy" boolean DEFAULT true NOT NULL,
	"archives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"log" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_restore" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"system_backup_key" text NOT NULL,
	"system_backup_at" timestamp NOT NULL,
	"database_log" text,
	"paused_backup_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paused_cron_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resumed_at" timestamp,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_restore_app" ADD CONSTRAINT "instance_restore_app_restore_id_instance_restore_id_fk" FOREIGN KEY ("restore_id") REFERENCES "public"."instance_restore"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_restore_app" ADD CONSTRAINT "instance_restore_app_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instance_restore_app_restore_idx" ON "instance_restore_app" USING btree ("restore_id","status");