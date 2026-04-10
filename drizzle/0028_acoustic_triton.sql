DROP TABLE IF EXISTS "integration" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "plugin_setting" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "plugin" CASCADE;--> statement-breakpoint
-- Backfill apps with null project_id: create a default project per org and assign orphan apps
DO $$
DECLARE
  org_row RECORD;
  default_project_id TEXT;
BEGIN
  FOR org_row IN
    SELECT DISTINCT a.organization_id
    FROM app a
    WHERE a.project_id IS NULL
  LOOP
    -- Check if a default project already exists for this org
    SELECT id INTO default_project_id
    FROM project
    WHERE organization_id = org_row.organization_id AND name = 'default'
    LIMIT 1;

    -- Create one if not
    IF default_project_id IS NULL THEN
      default_project_id := substr(md5(random()::text), 1, 21);
      INSERT INTO project (id, organization_id, name, display_name, is_system_managed)
      VALUES (default_project_id, org_row.organization_id, 'default', 'Default', false);
    END IF;

    -- Assign orphan apps
    UPDATE app
    SET project_id = default_project_id
    WHERE organization_id = org_row.organization_id AND project_id IS NULL;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "app" DROP CONSTRAINT IF EXISTS "app_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "app" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "is_system_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_type";
