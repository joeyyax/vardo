CREATE TABLE "container_self_heal" (
	"container_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"restarts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gave_up_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "container_self_heal" ADD CONSTRAINT "container_self_heal_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_self_heal_updated_at_idx" ON "container_self_heal" USING btree ("updated_at");