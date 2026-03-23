CREATE TYPE "public"."mesh_peer_status" AS ENUM('online', 'offline', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."mesh_peer_type" AS ENUM('persistent', 'dev');--> statement-breakpoint
CREATE TABLE "mesh_peer" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "mesh_peer_type" DEFAULT 'persistent' NOT NULL,
	"status" "mesh_peer_status" DEFAULT 'offline' NOT NULL,
	"endpoint" text,
	"public_key" text NOT NULL,
	"allowed_ips" text NOT NULL,
	"internal_ip" text NOT NULL,
	"api_url" text,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mesh_peer_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
CREATE TABLE "project_instance" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"mesh_peer_id" text,
	"environment" text NOT NULL,
	"git_ref" text,
	"status" "app_status" DEFAULT 'stopped' NOT NULL,
	"last_deployed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_instance_peer_env_uniq" UNIQUE("project_id","mesh_peer_id","environment")
);
--> statement-breakpoint
ALTER TABLE "project_instance" ADD CONSTRAINT "project_instance_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_instance" ADD CONSTRAINT "project_instance_mesh_peer_id_mesh_peer_id_fk" FOREIGN KEY ("mesh_peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_instance_peer_idx" ON "project_instance" USING btree ("mesh_peer_id");