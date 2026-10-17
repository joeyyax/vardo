ALTER TABLE "mesh_peer" ADD COLUMN "accept_builds" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_accepts_builds" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_ssh_key" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_ssh_host_key" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_ssh_port" integer;