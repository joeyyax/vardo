ALTER TABLE "uptime_monitor" ADD COLUMN "heavy_notice_dismissed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_result" ADD COLUMN "cache" text;--> statement-breakpoint
ALTER TABLE "uptime_result" ADD COLUMN "bytes" integer;