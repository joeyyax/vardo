ALTER TABLE "deployment" ADD COLUMN "build_outcome" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_target_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_target_name" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "image_transfer" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "image_transfer_ms" integer;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "image_transfer_bytes" bigint;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_context_bytes" bigint;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "image_bytes" bigint;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "build_peak_bytes" bigint;--> statement-breakpoint
CREATE INDEX "deployment_build_outcome_idx" ON "deployment" USING btree ("started_at") WHERE build_outcome is not null;