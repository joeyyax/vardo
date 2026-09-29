ALTER TABLE "api_token" ADD COLUMN "admin_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_token" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
UPDATE "api_token" SET "admin_access" = true WHERE "user_id" IN (SELECT "id" FROM "user" WHERE "is_app_admin" = true);
