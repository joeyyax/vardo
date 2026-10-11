ALTER TABLE "probe_ban" ADD COLUMN "blocked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "probe_ban" ADD COLUMN "last_blocked_at" timestamp with time zone;