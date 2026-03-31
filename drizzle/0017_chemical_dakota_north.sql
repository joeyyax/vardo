CREATE TYPE "public"."mesh_peer_connection_type" AS ENUM('direct', 'visible');--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "health_check_timeout" integer;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "connection_type" "mesh_peer_connection_type" DEFAULT 'direct' NOT NULL;
