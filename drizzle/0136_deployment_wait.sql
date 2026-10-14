ALTER TABLE "deployment" ADD COLUMN "wait_reason" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "wait_ahead" smallint;--> statement-breakpoint
CREATE INDEX "deployment_waiting_idx" ON "deployment" USING btree ("waiting_since") WHERE wait_reason is not null;