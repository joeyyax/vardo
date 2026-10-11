ALTER TABLE "mesh_peer" ADD COLUMN "accept_instance_signin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_accepts_instance_signin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "accept_instance_browse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_accepts_instance_browse" boolean DEFAULT false NOT NULL;