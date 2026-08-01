CREATE TYPE "public"."activity_family" AS ENUM('deploy', 'backup', 'cron', 'app', 'domain', 'security', 'system', 'org');--> statement-breakpoint
CREATE TYPE "public"."activity_outcome" AS ENUM('success', 'failure', 'neutral');--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "family" "activity_family";--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "outcome" "activity_outcome";--> statement-breakpoint
CREATE INDEX "activity_org_family_created_at_idx" ON "activity" USING btree ("organization_id","family","created_at");--> statement-breakpoint
CREATE INDEX "activity_org_outcome_created_at_idx" ON "activity" USING btree ("organization_id","outcome","created_at");--> statement-breakpoint
CREATE INDEX "activity_app_created_at_idx" ON "activity" USING btree ("app_id","created_at");--> statement-breakpoint
-- Backfill mirrors lib/activity/taxonomy.ts as of this migration. Longest
-- prefix first, so project.allow_docker_socket beats project.
UPDATE "activity" SET
  "family" = CASE
      WHEN left("action", 27) = 'project.allow_docker_socket' THEN 'security'
      WHEN left("action", 25) = 'project.allow_bind_mounts' THEN 'security'
      WHEN left("action", 19) = 'org.trusted_changed' THEN 'security'
      WHEN left("action", 11) = 'deployment.' THEN 'deploy'
      WHEN left("action", 11) = 'deploy_key.' THEN 'security'
      WHEN left("action", 11) = 'invitation.' THEN 'org'
      WHEN left("action", 10) = 'container.' THEN 'app'
      WHEN left("action", 9) = 'security.' THEN 'security'
      WHEN left("action", 9) = 'transfer.' THEN 'org'
      WHEN left("action", 8) = 'project.' THEN 'org'
      WHEN left("action", 7) = 'deploy.' THEN 'deploy'
      WHEN left("action", 7) = 'backup.' THEN 'backup'
      WHEN left("action", 7) = 'domain.' THEN 'domain'
      WHEN left("action", 7) = 'system.' THEN 'system'
      WHEN left("action", 7) = 'volume.' THEN 'app'
      WHEN left("action", 7) = 'member.' THEN 'org'
      WHEN left("action", 5) = 'cron.' THEN 'cron'
      WHEN left("action", 4) = 'app.' THEN 'app'
      WHEN left("action", 4) = 'org.' THEN 'org'
      ELSE 'org'
    END::activity_family,
  "outcome" = CASE
      WHEN "action" = 'volume.drift_detected' THEN 'failure'
      WHEN "action" = 'transfer.rejected' THEN 'failure'
      WHEN "action" = 'transfer.accepted' THEN 'success'
      WHEN "action" = 'deployment.rolled_back' THEN 'failure'
      WHEN "action" = 'deployment.instant_rollback' THEN 'neutral'
      WHEN "action" = 'deployment.cancelled' THEN 'neutral'
      WHEN right("action", 7) = '.failed' THEN 'failure'
      WHEN right("action", 8) = '.failure' THEN 'failure'
      WHEN right("action", 6) = '.error' THEN 'failure'
      WHEN right("action", 12) = '.unreachable' THEN 'failure'
      WHEN right("action", 10) = '.succeeded' THEN 'success'
      WHEN right("action", 8) = '.success' THEN 'success'
      WHEN right("action", 10) = '.completed' THEN 'success'
      ELSE 'neutral'
    END::activity_outcome
WHERE "family" IS NULL OR "outcome" IS NULL;