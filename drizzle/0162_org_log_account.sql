ALTER TABLE "organization" ADD COLUMN "log_account_id" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_log_account_id_unique" UNIQUE("log_account_id");