CREATE TABLE "probe_recommendation" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app" ALTER COLUMN "probe_guard" SET DEFAULT '{"enabled":true,"exceptions":[],"rules":{},"blocks":[],"templates":[],"robotsTxt":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "probe_recommendation" ADD CONSTRAINT "probe_recommendation_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_recommendation_app_template_uniq" ON "probe_recommendation" USING btree ("app_id","template_id");--> statement-breakpoint
UPDATE "app" SET "probe_guard" = ("probe_guard" - 'wordpress') || jsonb_build_object(
  'rules', CASE WHEN "probe_guard"->>'wordpress' = 'off'
    THEN '{"wp-login":true,"wp-admin":true,"xmlrpc":true,"wp-config":true}'::jsonb ELSE '{}'::jsonb END,
  'blocks', '[]'::jsonb,
  'templates', '[]'::jsonb)
WHERE "probe_guard" ? 'wordpress';
