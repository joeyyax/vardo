-- Make project_id required on the app table.
-- 1. Create a "Default" project for every org that has orphan apps.
-- 2. Assign orphan apps to their org's default project.
-- 3. Add NOT NULL constraint.
-- 4. Replace ON DELETE SET NULL with ON DELETE RESTRICT.

-- Step 1: Create "Default" projects for orgs with orphan apps
INSERT INTO "project" ("id", "organization_id", "name", "display_name", "description", "color", "created_at", "updated_at")
SELECT
  'default-' || a."organization_id",
  a."organization_id",
  'default',
  'Default',
  'Auto-created project for previously ungrouped apps',
  '#6366f1',
  NOW(),
  NOW()
FROM "app" a
WHERE a."project_id" IS NULL
GROUP BY a."organization_id"
ON CONFLICT ON CONSTRAINT "project_org_name_uniq" DO NOTHING;--> statement-breakpoint

-- Step 2: Assign orphan apps to their org's default project
UPDATE "app"
SET "project_id" = (
  SELECT p."id" FROM "project" p
  WHERE p."organization_id" = "app"."organization_id"
    AND p."name" = 'default'
  LIMIT 1
)
WHERE "project_id" IS NULL;--> statement-breakpoint

-- Step 3: Add NOT NULL constraint
ALTER TABLE "app" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint

-- Step 4: Replace FK — SET NULL -> RESTRICT
ALTER TABLE "app" DROP CONSTRAINT "app_project_id_project_id_fk";--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;
