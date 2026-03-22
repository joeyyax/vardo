CREATE TYPE "public"."invitation_scope" AS ENUM('platform', 'org', 'project');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "digest_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"day_of_week" integer DEFAULT 1 NOT NULL,
	"hour_of_day" integer DEFAULT 8 NOT NULL,
	"last_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "digest_setting_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"scope" "invitation_scope" NOT NULL,
	"target_id" text,
	"role" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "digest_setting" ADD CONSTRAINT "digest_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_target_scope_status_idx" ON "invitation" USING btree ("target_id","scope","status");--> statement-breakpoint
CREATE INDEX "api_token_hash_idx" ON "api_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_token_user_org_idx" ON "api_token" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "membership_user_id_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "membership_org_id_idx" ON "membership" USING btree ("organization_id");