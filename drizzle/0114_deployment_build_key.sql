ALTER TABLE "deployment" ADD COLUMN "build_key" text;--> statement-breakpoint
CREATE INDEX "deployment_app_build_key_idx" ON "deployment" USING btree ("app_id","build_key");