CREATE TABLE "image_update_track" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"compose_service" text,
	"mode" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "image_update_track_target_key" UNIQUE NULLS NOT DISTINCT("app_id","compose_service")
);
--> statement-breakpoint
ALTER TABLE "image_update_track" ADD CONSTRAINT "image_update_track_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_update_track" ADD CONSTRAINT "image_update_track_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_update_track_org_idx" ON "image_update_track" USING btree ("organization_id");