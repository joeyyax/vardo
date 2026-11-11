CREATE TABLE "ups_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 3493 NOT NULL,
	"ups_name" text NOT NULL,
	"username" text,
	"password" text,
	"tls" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ups_servers_target_idx" ON "ups_servers" USING btree ("host","port","ups_name");