CREATE TABLE "app_metric_hour" (
	"app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"metric_minutes" smallint DEFAULT 0 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"cpu_avg" real,
	"cpu_peak" real,
	"memory_avg" bigint,
	"memory_peak" bigint,
	"memory_limit" bigint,
	"network_rx_bytes" bigint,
	"network_tx_bytes" bigint,
	"checks_total" integer DEFAULT 0 NOT NULL,
	"checks_up" integer DEFAULT 0 NOT NULL,
	"response_count" integer DEFAULT 0 NOT NULL,
	"response_ms_sum" bigint DEFAULT 0 NOT NULL,
	"response_histogram" integer[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_metric_hour_app_id_hour_pk" PRIMARY KEY("app_id","hour")
);
--> statement-breakpoint
ALTER TABLE "app_metric_hour" ADD CONSTRAINT "app_metric_hour_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_metric_hour" ADD CONSTRAINT "app_metric_hour_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_metric_hour_org_hour_idx" ON "app_metric_hour" USING btree ("organization_id","hour");--> statement-breakpoint
CREATE INDEX "app_metric_hour_hour_idx" ON "app_metric_hour" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "domain_check_checked_at_idx" ON "domain_check" USING btree ("checked_at");