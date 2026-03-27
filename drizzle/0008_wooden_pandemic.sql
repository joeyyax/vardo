ALTER TYPE "public"."deployment_status" ADD VALUE 'superseded';--> statement-breakpoint
CREATE TABLE "user_digest_preference" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unq_user_digest_pref" UNIQUE("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "user_notification_preference" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unq_user_notification_pref" UNIQUE("user_id","organization_id","channel_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "public_api_url" text;--> statement-breakpoint
ALTER TABLE "user_digest_preference" ADD CONSTRAINT "user_digest_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_digest_preference" ADD CONSTRAINT "user_digest_preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preference" ADD CONSTRAINT "user_notification_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preference" ADD CONSTRAINT "user_notification_preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preference" ADD CONSTRAINT "user_notif_pref_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_digest_pref_user_idx" ON "user_digest_preference" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_notification_pref_user_idx" ON "user_notification_preference" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_notification_pref_channel_idx" ON "user_notification_preference" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_superseded_by_deployment_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."deployment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" DROP CONSTRAINT IF EXISTS "app_imported_container_uniq";--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_imported_container_uniq" UNIQUE("organization_id","imported_container_id");