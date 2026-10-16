CREATE TABLE "trust_check" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"evidence" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"visibility" text DEFAULT 'off' NOT NULL,
	"security_contact" text DEFAULT '' NOT NULL,
	"hosting_override" jsonb,
	"hosting_detected" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
