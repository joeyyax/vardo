CREATE TABLE "github_installation_org" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"linked_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gh_install_org_uniq" UNIQUE("organization_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "github_installation_org" ADD CONSTRAINT "github_installation_org_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_org" ADD CONSTRAINT "github_installation_org_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gh_install_org_installation_idx" ON "github_installation_org" USING btree ("installation_id");--> statement-breakpoint
-- Existing per-user links carry over to every org the linking user owns or administers.
INSERT INTO "github_installation_org" ("id", "organization_id", "installation_id", "linked_by_user_id")
SELECT gen_random_uuid()::text, m."organization_id", gi."installation_id", MIN(gi."user_id")
FROM "github_app_installation" gi
JOIN "membership" m ON m."user_id" = gi."user_id" AND m."role" IN ('owner', 'admin')
GROUP BY m."organization_id", gi."installation_id"
ON CONFLICT ("organization_id", "installation_id") DO NOTHING;
