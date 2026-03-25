CREATE INDEX "app_org_id_idx" ON "app" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "deployment_app_id_idx" ON "deployment" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "domain_app_id_idx" ON "domain" USING btree ("app_id");