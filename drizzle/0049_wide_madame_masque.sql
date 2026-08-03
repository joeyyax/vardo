-- Orphaned compose children: parent_app_id points at an app row that no longer
-- exists, so the constraint below cannot be added while they are present. Each
-- removal is written to the activity feed rather than disappearing silently.
WITH orphans AS (
  DELETE FROM "app" AS a
  WHERE a."parent_app_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "app" AS p WHERE p."id" = a."parent_app_id")
  RETURNING a."organization_id", a."name", a."parent_app_id"
)
INSERT INTO "activity" ("id", "organization_id", "app_id", "action", "metadata")
SELECT
  gen_random_uuid()::text,
  o."organization_id",
  NULL,
  'app.deleted',
  jsonb_build_object(
    'name', o."name",
    'source', 'migration',
    'reason', 'orphaned compose child',
    'parentAppId', o."parent_app_id"
  )
FROM orphans AS o;
--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_parent_app_id_app_id_fk" FOREIGN KEY ("parent_app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;
