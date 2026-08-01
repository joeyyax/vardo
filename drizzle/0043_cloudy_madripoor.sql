CREATE TABLE "domain_cert_check" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp,
	"fingerprint" text,
	"status" text NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_cert_check" ADD CONSTRAINT "domain_cert_check_domain_id_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("id") ON DELETE cascade ON UPDATE no action;