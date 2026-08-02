CREATE TABLE "image_update_ignore" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"compose_service" text,
	"scope" text DEFAULT 'all' NOT NULL,
	"expires_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "image_update_ignore_target_key" UNIQUE NULLS NOT DISTINCT("app_id","compose_service")
);
--> statement-breakpoint
ALTER TABLE "image_update_ignore" ADD CONSTRAINT "image_update_ignore_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_update_ignore" ADD CONSTRAINT "image_update_ignore_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_update_ignore_org_idx" ON "image_update_ignore" USING btree ("organization_id");