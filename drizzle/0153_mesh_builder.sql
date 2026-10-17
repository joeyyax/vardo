ALTER TABLE "mesh_peer" ADD COLUMN "peer_builder_key" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "builder_cert" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_builder_port" integer;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_builder_ca" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_builder_cert" text;