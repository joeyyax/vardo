ALTER TABLE "app" ADD COLUMN "anomaly_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "anomaly_sensitivity" text DEFAULT 'normal' NOT NULL;