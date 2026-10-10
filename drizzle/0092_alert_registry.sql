CREATE TABLE "alert_history" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"about" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"fired_at" timestamp NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "notification_send" (
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"about" text NOT NULL,
	"severity" text NOT NULL,
	"sent_at" timestamp NOT NULL,
	"cleared_at" timestamp,
	"detail" jsonb,
	CONSTRAINT "notification_send_organization_id_type_about_pk" PRIMARY KEY("organization_id","type","about")
);
--> statement-breakpoint
CREATE TABLE "notification_setting" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batch_window_minutes" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_history" ADD CONSTRAINT "alert_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_history_org_fired_idx" ON "alert_history" USING btree ("organization_id","fired_at");--> statement-breakpoint
CREATE INDEX "alert_history_open_idx" ON "alert_history" USING btree ("organization_id","type","about");