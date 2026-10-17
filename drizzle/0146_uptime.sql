CREATE TABLE "uptime_daily" (
	"monitor_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"minutes_up" integer NOT NULL,
	"minutes_down" integer NOT NULL,
	"minutes_unknown" integer NOT NULL,
	"median_latency_ms" integer,
	CONSTRAINT "uptime_daily_monitor_id_start_pk" PRIMARY KEY("monitor_id","start")
);
--> statement-breakpoint
CREATE TABLE "uptime_hourly" (
	"monitor_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"minutes_up" integer NOT NULL,
	"minutes_down" integer NOT NULL,
	"minutes_unknown" integer NOT NULL,
	"median_latency_ms" integer,
	"record" text,
	"sig" text,
	"signed_at" timestamp with time zone,
	CONSTRAINT "uptime_hourly_monitor_id_start_pk" PRIMARY KEY("monitor_id","start")
);
--> statement-breakpoint
CREATE TABLE "uptime_monitor" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"check" jsonb NOT NULL,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"app_id" text,
	"domain_id" text,
	"environment_id" text,
	"preview" boolean DEFAULT false NOT NULL,
	"maintenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uptime_result" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"vantage_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"status" integer,
	"error" text,
	"cert_days_left" integer
);
--> statement-breakpoint
CREATE TABLE "uptime_vantage" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location" text,
	"public_key" text NOT NULL,
	"private_key_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uptime_daily" ADD CONSTRAINT "uptime_daily_monitor_id_uptime_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."uptime_monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_hourly" ADD CONSTRAINT "uptime_hourly_monitor_id_uptime_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."uptime_monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD CONSTRAINT "uptime_monitor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD CONSTRAINT "uptime_monitor_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD CONSTRAINT "uptime_monitor_domain_id_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_monitor" ADD CONSTRAINT "uptime_monitor_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_result" ADD CONSTRAINT "uptime_result_monitor_id_uptime_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."uptime_monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uptime_monitor_org_idx" ON "uptime_monitor" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "uptime_monitor_app_idx" ON "uptime_monitor" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uptime_monitor_domain_uniq" ON "uptime_monitor" USING btree ("domain_id") WHERE "uptime_monitor"."domain_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uptime_monitor_env_uniq" ON "uptime_monitor" USING btree ("environment_id") WHERE "uptime_monitor"."environment_id" is not null;--> statement-breakpoint
CREATE INDEX "uptime_result_monitor_at_idx" ON "uptime_result" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "uptime_result_at_idx" ON "uptime_result" USING btree ("at");