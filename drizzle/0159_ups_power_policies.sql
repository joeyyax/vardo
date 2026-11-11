CREATE TABLE "power_action" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"outage_started_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "power_stopped_app" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"outage_started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	"outcome" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "keep_running_on_battery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "power_stopped_app" ADD CONSTRAINT "power_stopped_app_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_stopped_app" ADD CONSTRAINT "power_stopped_app_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "power_action_created_idx" ON "power_action" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "power_action_kind_outage_idx" ON "power_action" USING btree ("kind","outage_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "power_stopped_app_open_uniq" ON "power_stopped_app" USING btree ("app_id") WHERE restored_at is null;