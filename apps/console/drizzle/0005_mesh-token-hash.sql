ALTER TABLE "mesh_peer" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD CONSTRAINT "mesh_peer_token_hash_unique" UNIQUE("token_hash");