CREATE TABLE "user_star" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" text,
	"app_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_star_one_target" CHECK (("user_star"."kind" = 'project' AND "user_star"."project_id" IS NOT NULL AND "user_star"."app_id" IS NULL) OR ("user_star"."kind" = 'app' AND "user_star"."app_id" IS NOT NULL AND "user_star"."project_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN "project_sort" text DEFAULT 'attention' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_star" ADD CONSTRAINT "user_star_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_star" ADD CONSTRAINT "user_star_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_star" ADD CONSTRAINT "user_star_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_star" ADD CONSTRAINT "user_star_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_star_project_uniq" ON "user_star" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_star_app_uniq" ON "user_star" USING btree ("user_id","app_id");--> statement-breakpoint
CREATE INDEX "user_star_user_org_idx" ON "user_star" USING btree ("user_id","organization_id");