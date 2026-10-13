CREATE TABLE "app_recap" (
	"app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "app_recap_app_id_kind_pk" PRIMARY KEY("app_id","kind")
);
--> statement-breakpoint
ALTER TABLE "app_recap" ADD CONSTRAINT "app_recap_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_recap" ADD CONSTRAINT "app_recap_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_recap_due_idx" ON "app_recap" USING btree ("due_at");