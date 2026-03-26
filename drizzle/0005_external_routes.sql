CREATE TABLE "external_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"target_url" text,
	"tls" boolean DEFAULT false NOT NULL,
	"insecure_skip_verify" boolean DEFAULT false NOT NULL,
	"redirect_url" text,
	"redirect_permanent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_routes_hostname_unique" UNIQUE("hostname")
);
