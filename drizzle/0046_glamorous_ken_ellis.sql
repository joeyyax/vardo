ALTER TABLE "backup" ADD COLUMN "strategy" text;--> statement-breakpoint
-- Backfill from the archive extension, the only place the format was recorded
-- before this column existed. Rows with no storage_path have no archive.
UPDATE "backup" SET "strategy" = 'dump' WHERE "storage_path" LIKE '%.dump.gz';--> statement-breakpoint
UPDATE "backup" SET "strategy" = 'tar' WHERE "storage_path" LIKE '%.tar.gz';
