ALTER TABLE "api_token" ADD COLUMN "linked_instances" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "accept_mcp" boolean DEFAULT false NOT NULL;