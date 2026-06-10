ALTER TABLE "domain" ALTER COLUMN "cert_resolver" SET DEFAULT 'le-dns';--> statement-breakpoint
UPDATE "domain" SET "cert_resolver" = 'le-dns' WHERE "cert_resolver" = 'le';
