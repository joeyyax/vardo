BEGIN;

-- 1. Create new enums
CREATE TYPE "public"."clone_strategy" AS ENUM('clone', 'clone_data', 'empty', 'skip');
CREATE TYPE "public"."group_environment_type" AS ENUM('staging', 'preview');

-- 2. Add columns to project table
ALTER TABLE "project" ADD COLUMN "group_id" TEXT REFERENCES "group"("id") ON DELETE SET NULL;
ALTER TABLE "project" ADD COLUMN "clone_strategy" "clone_strategy" DEFAULT 'clone';
ALTER TABLE "project" ADD COLUMN "depends_on" JSONB;

-- 3. Create group_environment table
CREATE TABLE "group_environment" (
  "id" TEXT PRIMARY KEY,
  "group_id" TEXT NOT NULL REFERENCES "group"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" "group_environment_type" NOT NULL DEFAULT 'staging',
  "source_environment" TEXT DEFAULT 'production',
  "pr_number" INTEGER,
  "pr_url" TEXT,
  "created_by" TEXT REFERENCES "user"("id"),
  "expires_at" TIMESTAMP,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  CONSTRAINT "group_env_group_name_uniq" UNIQUE("group_id", "name")
);

-- 4. Add group_environment_id to environment table
ALTER TABLE "environment" ADD COLUMN "group_environment_id" TEXT REFERENCES "group_environment"("id") ON DELETE CASCADE;

-- 5. Add group_environment_id to deployment table
ALTER TABLE "deployment" ADD COLUMN "group_environment_id" TEXT REFERENCES "group_environment"("id") ON DELETE SET NULL;

-- 6. Fix env_var unique constraint: scope by environment_id
ALTER TABLE "env_var" DROP CONSTRAINT "env_var_project_key_uniq";
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_project_key_env_uniq" UNIQUE("project_id", "key", "environment_id");

COMMIT;
