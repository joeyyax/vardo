CREATE TABLE "project_watch" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_watch_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "user_digest_preference" ADD COLUMN "frequency" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_digest_preference" ADD COLUMN "last_window_key" text;--> statement-breakpoint
-- A row is a choice someone made with the old toggle: on stays weekly, off stays off.
UPDATE "user_digest_preference" SET "frequency" = CASE WHEN "enabled" THEN 'weekly' ELSE 'off' END;--> statement-breakpoint
ALTER TABLE "project_watch" ADD CONSTRAINT "project_watch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_watch" ADD CONSTRAINT "project_watch_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_watch_project_idx" ON "project_watch" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "digest_setting" DROP COLUMN "cadence";--> statement-breakpoint
ALTER TABLE "digest_setting" DROP COLUMN "last_window_key";--> statement-breakpoint
ALTER TABLE "user_digest_preference" DROP COLUMN "enabled";