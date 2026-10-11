CREATE TABLE "probe_ban" (
	"id" text PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"reason" text NOT NULL,
	"app_id" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"origin_peer_id" text,
	"origin_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE TABLE "probe_canary" (
	"id" text PRIMARY KEY NOT NULL,
	"marker" text NOT NULL,
	"ip" text NOT NULL,
	"app_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "probe_canary_marker_unique" UNIQUE("marker")
);
--> statement-breakpoint
CREATE TABLE "probe_event" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ip" text NOT NULL,
	"path" text,
	"canary_id" text,
	"app_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "probe_guard" jsonb DEFAULT '{"enabled":true,"exceptions":[],"wordpress":"auto","robotsTxt":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "probe_ban" ADD CONSTRAINT "probe_ban_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_ban" ADD CONSTRAINT "probe_ban_origin_peer_id_mesh_peer_id_fk" FOREIGN KEY ("origin_peer_id") REFERENCES "public"."mesh_peer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_canary" ADD CONSTRAINT "probe_canary_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_event" ADD CONSTRAINT "probe_event_canary_id_probe_canary_id_fk" FOREIGN KEY ("canary_id") REFERENCES "public"."probe_canary"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_event" ADD CONSTRAINT "probe_event_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "probe_ban_ip_idx" ON "probe_ban" USING btree ("ip");--> statement-breakpoint
CREATE INDEX "probe_ban_expires_at_idx" ON "probe_ban" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "probe_ban_app_created_idx" ON "probe_ban" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "probe_canary_ip_idx" ON "probe_canary" USING btree ("ip");--> statement-breakpoint
CREATE INDEX "probe_event_created_at_idx" ON "probe_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "probe_event_app_created_idx" ON "probe_event" USING btree ("app_id","created_at");