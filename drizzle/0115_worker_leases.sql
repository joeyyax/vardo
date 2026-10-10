CREATE TABLE "container_hold" (
	"container_id" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"holder" text,
	"interval_ms" integer NOT NULL,
	"last_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_lease" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
