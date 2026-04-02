CREATE TYPE "public"."integration_status" AS ENUM('connected', 'disconnected', 'degraded');--> statement-breakpoint
CREATE TYPE "public"."integration_type" AS ENUM('metrics', 'error_tracking', 'uptime', 'logging');--> statement-breakpoint
CREATE TABLE "integration" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "integration_type" NOT NULL,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"app_id" text,
	"external_url" text,
	"credentials" text,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_type_idx" ON "integration" USING btree ("type");--> statement-breakpoint
CREATE INDEX "integration_app_id_idx" ON "integration" USING btree ("app_id");