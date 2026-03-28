ALTER TABLE "volume" ADD COLUMN "type" text DEFAULT 'named' NOT NULL;--> statement-breakpoint
CREATE INDEX "user_digest_pref_org_idx" ON "user_digest_preference" USING btree ("organization_id");