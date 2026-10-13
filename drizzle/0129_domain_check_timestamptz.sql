-- Existing values were written as UTC wall-clock time; read them as UTC, whatever the session zone.
ALTER TABLE "domain_check" ALTER COLUMN "checked_at" SET DATA TYPE timestamp with time zone USING "checked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "domain_check" ALTER COLUMN "checked_at" SET DEFAULT now();
