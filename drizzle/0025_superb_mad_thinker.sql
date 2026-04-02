DROP INDEX "integration_type_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "integration_type_idx" ON "integration" USING btree ("type");