ALTER TABLE "uptime_monitor" ADD COLUMN "health_path" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "health_source" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "health_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "review_status" integer;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "review_answer" jsonb;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "overrides" jsonb;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "link_domain_id" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "link_domain" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "headers_encrypted" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "header_names" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "share_headers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_watch_entry" ADD COLUMN "headers_encrypted" text;