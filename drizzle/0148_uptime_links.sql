CREATE TABLE "uptime_probe_result" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"peer_id" text NOT NULL,
	"monitor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"status" integer,
	"error" text,
	"cert_days_left" integer,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "uptime_probe_summary" (
	"peer_id" text NOT NULL,
	"monitor_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"record" text NOT NULL,
	"sig" text NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "uptime_probe_summary_peer_id_monitor_id_start_pk" PRIMARY KEY("peer_id","monitor_id","start")
);
--> statement-breakpoint
CREATE TABLE "uptime_record" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vantage_id" text NOT NULL,
	"kind" text NOT NULL,
	"monitor_id" text,
	"issued_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" text NOT NULL,
	"sig" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uptime_watch_entry" (
	"peer_id" text NOT NULL,
	"monitor_id" text NOT NULL,
	"check" jsonb NOT NULL,
	"interval_sec" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uptime_watch_entry_peer_id_monitor_id_pk" PRIMARY KEY("peer_id","monitor_id")
);
--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "uptime_checks_us" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mesh_peer" ADD COLUMN "uptime_checks_peer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_result" ADD COLUMN "record_id" bigint;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "mesh_peer_id" text;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "remote_id" text;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD COLUMN "watching" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "uptime_probe_result" ADD CONSTRAINT "uptime_probe_result_peer_id_mesh_peer_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_probe_summary" ADD CONSTRAINT "uptime_probe_summary_peer_id_mesh_peer_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_record" ADD CONSTRAINT "uptime_record_vantage_id_uptime_vantage_id_fk" FOREIGN KEY ("vantage_id") REFERENCES "public"."uptime_vantage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_watch_entry" ADD CONSTRAINT "uptime_watch_entry_peer_id_mesh_peer_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uptime_probe_result_pending_idx" ON "uptime_probe_result" USING btree ("peer_id","delivered_at");--> statement-breakpoint
CREATE INDEX "uptime_probe_result_at_idx" ON "uptime_probe_result" USING btree ("at");--> statement-breakpoint
CREATE INDEX "uptime_record_vantage_idx" ON "uptime_record" USING btree ("vantage_id","kind","monitor_id","issued_at");--> statement-breakpoint
ALTER TABLE "uptime_result" ADD CONSTRAINT "uptime_result_record_id_uptime_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."uptime_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_vantage" ADD CONSTRAINT "uptime_vantage_mesh_peer_id_mesh_peer_id_fk" FOREIGN KEY ("mesh_peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uptime_result_external_uniq" ON "uptime_result" USING btree ("monitor_id","vantage_id","at") WHERE "uptime_result"."record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uptime_vantage_peer_uniq" ON "uptime_vantage" USING btree ("mesh_peer_id") WHERE "uptime_vantage"."mesh_peer_id" is not null;