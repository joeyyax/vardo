ALTER TABLE "mesh_peer" ADD COLUMN "outbound_token" text;--> statement-breakpoint
ALTER TABLE "project_instance" ADD COLUMN "compose_content" text;--> statement-breakpoint
ALTER TABLE "project_instance" ADD COLUMN "source_instance_id" text;--> statement-breakpoint
ALTER TABLE "project_instance" ADD COLUMN "transferred_at" timestamp;