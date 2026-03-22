ALTER TABLE "organizations" ALTER COLUMN "features" SET DEFAULT '{"time_tracking":true,"invoicing":true,"expenses":true,"pm":false,"proposals":false,"defaultAssignee":null,"secondMemberNudge":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;