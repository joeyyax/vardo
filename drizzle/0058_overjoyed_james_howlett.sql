ALTER TABLE "app" ADD COLUMN "namespace" text;--> statement-breakpoint
CREATE UNIQUE INDEX "app_top_level_namespace_uniq" ON "app" USING btree ("namespace") WHERE parent_app_id is null and namespace is not null;--> statement-breakpoint
-- Existing apps keep the name their resources are already on disk under, so this
-- migration moves nothing. It only makes the indirection exist, which is what
-- stops a later rename from moving anything.
UPDATE "app" SET "namespace" = "name" WHERE "parent_app_id" IS NULL AND "namespace" IS NULL;