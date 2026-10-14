CREATE TABLE "build_peak" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"peak_bytes" bigint NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_peak" ADD CONSTRAINT "build_peak_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_peak_recorded_at_idx" ON "build_peak" USING btree ("recorded_at");