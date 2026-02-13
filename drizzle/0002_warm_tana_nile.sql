CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "team_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "email_sends" RENAME COLUMN "resend_email_id" TO "external_email_id";--> statement-breakpoint
ALTER TABLE "inbox_items" RENAME COLUMN "resend_email_id" TO "external_email_id";--> statement-breakpoint
ALTER TABLE "email_sends" DROP CONSTRAINT "email_sends_resend_email_id_unique";--> statement-breakpoint
DROP INDEX "email_sends_resend_id_idx";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "converted_to" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "join_token" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "join_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_project_user_idx" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "email_sends_external_id_idx" ON "email_sends" USING btree ("external_email_id");--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_external_email_id_unique" UNIQUE("external_email_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_join_token_unique" UNIQUE("join_token");