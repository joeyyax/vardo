ALTER TABLE "domain" DROP CONSTRAINT "domain_domain_unique";--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "path_prefix" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "strip_path_prefix" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_host_path_uniq" ON "domain" USING btree ("domain",coalesce("path_prefix", ''));