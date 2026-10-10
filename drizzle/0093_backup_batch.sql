CREATE TABLE "backup_batch" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"opened_at" timestamp NOT NULL,
	"flush_at" timestamp NOT NULL,
	"flushed_at" timestamp,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup_batch" ADD CONSTRAINT "backup_batch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_batch_open_idx" ON "backup_batch" USING btree ("organization_id") WHERE "backup_batch"."flushed_at" is null;