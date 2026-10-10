ALTER TABLE "mesh_peer" ADD COLUMN "vardo_sha" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "vardo_sha_since" timestamp;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "vardo_healthy" boolean;