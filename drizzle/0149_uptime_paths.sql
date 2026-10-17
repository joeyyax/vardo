ALTER TABLE "uptime_monitor" ADD COLUMN "mesh_peer_id" text;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD COLUMN "peer_role" text;--> statement-breakpoint
ALTER TABLE "uptime_probe_result" ADD COLUMN "path" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_result" ADD COLUMN "path" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "mesh_watching" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_watch_entry" ADD COLUMN "path" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD CONSTRAINT "uptime_monitor_mesh_peer_id_mesh_peer_id_fk" FOREIGN KEY ("mesh_peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "uptime_result" SET "path" = 'local' WHERE "vantage_id" = 'local';