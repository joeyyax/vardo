CREATE TABLE "initial_backup" (
	"app_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"armed_at" timestamp NOT NULL,
	"due_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"outcome" text,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "initial_backup" ADD CONSTRAINT "initial_backup_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;