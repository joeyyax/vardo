CREATE TABLE "org_build_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_build_secret_org_name_uniq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "org_build_secret" ADD CONSTRAINT "org_build_secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;