ALTER TABLE "app" ADD COLUMN "git_credentials" text;--> statement-breakpoint
-- Scrub copies of each app's git userinfo before it leaves git_url.
UPDATE "deployment" d
SET "config_snapshot" = replace(d."config_snapshot"::text, c.creds || '@', '')::jsonb
FROM (SELECT "id", substring("git_url" from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)@') AS creds FROM "app") c
WHERE d."app_id" = c."id"
  AND c.creds <> '' AND c.creds !~ '["\\]'
  AND d."config_snapshot" IS NOT NULL
  AND strpos(d."config_snapshot"::text, c.creds || '@') > 0;--> statement-breakpoint
UPDATE "deployment" d
SET "log" = replace(d."log", c.creds || '@', '[redacted]@')
FROM (SELECT "id", substring("git_url" from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)@') AS creds FROM "app") c
WHERE d."app_id" = c."id"
  AND c.creds <> ''
  AND strpos(d."log", c.creds || '@') > 0;--> statement-breakpoint
UPDATE "activity" a
SET "metadata" = replace(a."metadata"::text, c.creds || '@', '[redacted]@')::jsonb
FROM (SELECT "id", substring("git_url" from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)@') AS creds FROM "app") c
WHERE a."app_id" = c."id"
  AND c.creds <> '' AND c.creds !~ '["\\]'
  AND a."metadata" IS NOT NULL
  AND strpos(a."metadata"::text, c.creds || '@') > 0;--> statement-breakpoint
-- Move the userinfo out of git_url. The startup credential pass encrypts it.
UPDATE "app"
SET "git_credentials" = nullif(substring("git_url" from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)@'), ''),
    "git_url" = regexp_replace("git_url", '^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@', '\1')
WHERE "git_url" ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
