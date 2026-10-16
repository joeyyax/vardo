CREATE TABLE "trust_document" (
	"id" text PRIMARY KEY NOT NULL,
	"reviewed_body" text,
	"reviewed_at" timestamp,
	"basis_hash" text,
	"file" "bytea",
	"file_size" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
