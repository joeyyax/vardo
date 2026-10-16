CREATE TABLE "trust_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"score" integer NOT NULL,
	"max" integer NOT NULL,
	"weights" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trust_check" ADD COLUMN "credit" real;