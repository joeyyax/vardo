CREATE TABLE "client_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"contact_id" uuid,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"visibility" jsonb DEFAULT '{"show_rates":false,"show_time":true,"show_costs":false}'::jsonb,
	"invited_by" text,
	"token" text NOT NULL,
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"accepted_at" timestamp,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "client_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "contact_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"is_shared" boolean DEFAULT false,
	"shared_at" timestamp,
	"shared_by" text,
	"is_pinned" boolean DEFAULT false,
	"pinned_at" timestamp,
	"pinned_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_watchers" (
	"contact_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contact_watchers_contact_id_user_id_pk" PRIMARY KEY("contact_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resend_email_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"subject" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp,
	"opened_at" timestamp,
	"bounced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_sends_resend_email_id_unique" UNIQUE("resend_email_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_item_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"r2_key" text NOT NULL,
	"source" text DEFAULT 'attachment',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"resend_email_id" text,
	"from_address" text,
	"from_name" text,
	"subject" text,
	"received_at" timestamp NOT NULL,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"converted_expense_id" uuid,
	"client_id" uuid,
	"project_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "client_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "client_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "intake_email_token" text;--> statement-breakpoint
ALTER TABLE "document_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "document_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "document_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "expense_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "expense_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "expense_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "invoice_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "invoice_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoice_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "voided_at" timestamp;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "email_delivery" text DEFAULT 'immediate';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "intake_email_token" text;--> statement-breakpoint
ALTER TABLE "project_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "project_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "project_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "project_files" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "intake_email_token" text;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "is_pinned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_invitations" ADD CONSTRAINT "client_invitations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_comments" ADD CONSTRAINT "contact_comments_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_comments" ADD CONSTRAINT "contact_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_comments" ADD CONSTRAINT "contact_comments_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_comments" ADD CONSTRAINT "contact_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_watchers" ADD CONSTRAINT "contact_watchers_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_watchers" ADD CONSTRAINT "contact_watchers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item_files" ADD CONSTRAINT "inbox_item_files_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_converted_expense_id_project_expenses_id_fk" FOREIGN KEY ("converted_expense_id") REFERENCES "public"."project_expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_invitations_client_id_idx" ON "client_invitations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_invitations_email_idx" ON "client_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "client_invitations_token_idx" ON "client_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "email_sends_org_idx" ON "email_sends" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "email_sends_resend_id_idx" ON "email_sends" USING btree ("resend_email_id");--> statement-breakpoint
CREATE INDEX "email_sends_entity_idx" ON "email_sends" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "inbox_item_files_item_id_idx" ON "inbox_item_files" USING btree ("inbox_item_id");--> statement-breakpoint
CREATE INDEX "inbox_items_org_id_idx" ON "inbox_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inbox_items_status_idx" ON "inbox_items" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "inbox_items_received_at_idx" ON "inbox_items" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "inbox_items_client_id_idx" ON "inbox_items" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "inbox_items_project_id_idx" ON "inbox_items" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_contacts_project_contact_idx" ON "project_contacts" USING btree ("project_id","contact_id");--> statement-breakpoint
CREATE INDEX "project_contacts_project_id_idx" ON "project_contacts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_contacts_contact_id_idx" ON "project_contacts" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "client_comments" ADD CONSTRAINT "client_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_comments" ADD CONSTRAINT "expense_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_comments" ADD CONSTRAINT "invoice_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_comments" ADD CONSTRAINT "project_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_files_replaces_id_idx" ON "project_files" USING btree ("replaces_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_intake_email_token_unique" UNIQUE("intake_email_token");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_intake_email_token_unique" UNIQUE("intake_email_token");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_intake_email_token_unique" UNIQUE("intake_email_token");