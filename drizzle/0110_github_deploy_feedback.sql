ALTER TABLE "app" ADD COLUMN "github_feedback" boolean;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "github_feedback_error" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "github_feedback_blocked_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "github_feedback" boolean DEFAULT true NOT NULL;