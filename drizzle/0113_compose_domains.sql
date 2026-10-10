ALTER TABLE "domain" ADD COLUMN "source" text DEFAULT 'vardo' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "compose_router" text;