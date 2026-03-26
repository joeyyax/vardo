ALTER TABLE "domain" ADD COLUMN "redirect_to" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "redirect_code" integer DEFAULT 301;