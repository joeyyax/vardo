ALTER TABLE "deployment" ADD COLUMN "slot" text;--> statement-breakpoint
CREATE INDEX "deployment_app_status_slot_idx" ON "deployment" USING btree ("app_id","status","slot");