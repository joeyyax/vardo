ALTER TABLE "notification_log" ADD COLUMN "provider_message_ids" text[];--> statement-breakpoint
ALTER TABLE "notification_log" ADD COLUMN "delivery_status" text;--> statement-breakpoint
CREATE INDEX "notification_log_provider_message_ids_idx" ON "notification_log" USING gin ("provider_message_ids");