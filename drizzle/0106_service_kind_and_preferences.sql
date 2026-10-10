CREATE TABLE "user_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"density" text DEFAULT 'comfortable' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "kind_override" text;--> statement-breakpoint
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;