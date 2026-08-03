ALTER TABLE "app" ADD COLUMN "parked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Stacks already shelved. Left unparked they would all go loud the day the
-- column lands, which is the one thing this flag exists to stop.
UPDATE "app" SET "parked" = true
WHERE "parent_app_id" IS NULL AND "name" IN ('agents', 'encoder', 'jellyfin', 'lonvr');--> statement-breakpoint
UPDATE "app" SET "parked" = true
WHERE "parent_app_id" IN (SELECT "id" FROM "app" WHERE "parked" = true);--> statement-breakpoint
-- A running app's container start is a measured fact and the clock the uptime
-- column already runs on. Nothing on the row records when a stopped, missing or
-- errored app went down — last_running_at was set to now() for every row by
-- 0051, so it would report months of downtime as hours. Those stay null and
-- render no duration at all.
UPDATE "app" SET "status_changed_at" = "container_started_at"
WHERE "status_changed_at" IS NULL AND "status" = 'active' AND "container_started_at" IS NOT NULL;
