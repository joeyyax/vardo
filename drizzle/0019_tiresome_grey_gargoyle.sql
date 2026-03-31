CREATE TABLE "app_security_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "gpu_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "health_check_timeout" integer;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "backend_protocol" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "imported_compose_project" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_security_scan" ADD CONSTRAINT "app_security_scan_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_security_scan" ADD CONSTRAINT "app_security_scan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_security_scan_app_id_idx" ON "app_security_scan" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_security_scan_org_id_idx" ON "app_security_scan" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "app_security_scan_app_started_at_idx" ON "app_security_scan" USING btree ("app_id","started_at");--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_imported_compose_project_uniq" UNIQUE("organization_id","imported_compose_project");