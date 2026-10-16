CREATE TABLE "trust_subprocessor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"region" text,
	"status" text DEFAULT 'suggested' NOT NULL,
	"detected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trust_subprocessor_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "trust_settings" ADD COLUMN "cloudflare" jsonb;