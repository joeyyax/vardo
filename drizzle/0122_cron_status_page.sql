CREATE TABLE "cron_status_page" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"token" text NOT NULL,
	"hostname" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cron_status_page_token_unique" UNIQUE("token"),
	CONSTRAINT "cron_status_page_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "cron_status_page" ADD CONSTRAINT "cron_status_page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;