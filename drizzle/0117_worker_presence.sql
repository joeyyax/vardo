CREATE TABLE "worker" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"slot" text,
	"git_sha" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"draining_at" timestamp with time zone,
	"drain_requested_at" timestamp with time zone,
	"in_flight" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "console_at" timestamp;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "worker_at" timestamp;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "worker_ready" boolean;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "watchdog_at" timestamp;