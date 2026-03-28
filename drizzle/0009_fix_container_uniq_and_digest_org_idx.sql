-- Revert imported_container_id unique constraint to global scope.
-- The org-scoped constraint added in 0008 allows two orgs to race on the same
-- physical container, which corrupts host state. Global uniqueness is required.
ALTER TABLE "app" DROP CONSTRAINT IF EXISTS "app_imported_container_uniq";--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_imported_container_uniq" UNIQUE("imported_container_id");--> statement-breakpoint

-- Add missing index on user_digest_preference.organization_id.
-- The weekly digest job queries by organization_id; without an index this is a
-- full table scan that becomes expensive as user counts grow.
CREATE INDEX "user_digest_pref_org_idx" ON "user_digest_preference" USING btree ("organization_id");
