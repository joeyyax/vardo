ALTER TYPE "public"."deployment_trigger" ADD VALUE 'relay';--> statement-breakpoint
ALTER TYPE "public"."deployment_trigger" ADD VALUE 'poll';--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "git_polled_at" timestamp;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "git_polled_sha" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "git_poll_error" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "accept_webhook_relay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "peer_accepts_webhook_relay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "last_relay_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "last_relay_sent_status" text;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "last_relay_received_at" timestamp;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "last_relay_received_status" text;