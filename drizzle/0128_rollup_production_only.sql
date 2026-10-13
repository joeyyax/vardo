-- Rows since the rollup shipped mix environments. Clear what the raw store still holds and re-roll it.
DELETE FROM "app_metric_hour" WHERE "hour" >= now() - interval '7 days';--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" = 'metrics-rollup:rolled-until';
