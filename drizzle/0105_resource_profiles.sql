CREATE TABLE "app_memory_autotune" (
	"app_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"applied_mb" integer,
	"last_raised_at" timestamp,
	"last_changed_at" timestamp,
	"last_reason" text,
	"raise_streak" integer DEFAULT 0 NOT NULL,
	"halted_at" timestamp,
	"daily_peaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "memory_profile" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "memory_reservation" integer;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "memory_auto_min_mb" integer;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "memory_auto_max_mb" integer;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "cpu_profile" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_profile" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "cpu_profile" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_auto_max_mb" integer;--> statement-breakpoint
ALTER TABLE "app_memory_autotune" ADD CONSTRAINT "app_memory_autotune_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_memory_autotune" ADD CONSTRAINT "app_memory_autotune_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;