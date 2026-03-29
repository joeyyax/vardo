ALTER TABLE "app" ADD COLUMN "backend_protocol" text;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_backend_protocol_check" CHECK (backend_protocol IN ('http', 'https'));
