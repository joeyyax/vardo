CREATE TABLE "hook_registration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"app_id" text,
	"event" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"fail_mode" text DEFAULT 'fail' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notification" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"action_url" text,
	"read_at" timestamp,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"organization_id" text,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_setting_uniq" UNIQUE("plugin_id","organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "plugin" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text,
	"category" text,
	"manifest" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hook_registration" ADD CONSTRAINT "hook_registration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hook_registration" ADD CONSTRAINT "hook_registration_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification" ADD CONSTRAINT "user_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification" ADD CONSTRAINT "user_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_setting" ADD CONSTRAINT "plugin_setting_plugin_id_plugin_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_setting" ADD CONSTRAINT "plugin_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hook_registration_event_idx" ON "hook_registration" USING btree ("event","enabled");--> statement-breakpoint
CREATE INDEX "hook_registration_org_idx" ON "hook_registration" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "user_notification_user_unread_idx" ON "user_notification" USING btree ("user_id","dismissed_at");--> statement-breakpoint
CREATE INDEX "plugin_setting_plugin_idx" ON "plugin_setting" USING btree ("plugin_id");