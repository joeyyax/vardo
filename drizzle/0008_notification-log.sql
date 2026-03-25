CREATE TABLE "notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" text,
	"channel_name" text NOT NULL,
	"channel_type" text NOT NULL,
	"event_type" text NOT NULL,
	"event_title" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_log_org_idx" ON "notification_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_log_created_idx" ON "notification_log" USING btree ("created_at");