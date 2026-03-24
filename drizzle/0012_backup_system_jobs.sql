ALTER TABLE "backup" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "backup_job" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_job" ALTER COLUMN "organization_id" DROP NOT NULL;
