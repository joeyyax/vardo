ALTER TABLE "invitation" ADD COLUMN "token_hash" text;--> statement-breakpoint
UPDATE "invitation" SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_token_unique";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "token";
