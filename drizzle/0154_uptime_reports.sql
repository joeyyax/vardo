CREATE TABLE "uptime_peer_report" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"remote_id" text NOT NULL,
	"public_key" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" text NOT NULL,
	"sig" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "reporting" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uptime_peer_report" ADD CONSTRAINT "uptime_peer_report_peer_id_mesh_peer_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;