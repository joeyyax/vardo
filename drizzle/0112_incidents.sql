CREATE TABLE "incident" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"app_id" text,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"peak_severity" text NOT NULL,
	"state" text NOT NULL,
	"opened_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"update_count" integer DEFAULT 0 NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"last_notified_state" text,
	"last_notified_at" timestamp,
	"channel_messages" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_open_key_uniq" ON "incident" USING btree ("organization_id","key") WHERE "incident"."state" = 'open';--> statement-breakpoint
CREATE INDEX "incident_org_key_idx" ON "incident" USING btree ("organization_id","key","resolved_at");--> statement-breakpoint
CREATE INDEX "incident_org_state_idx" ON "incident" USING btree ("organization_id","state","updated_at");